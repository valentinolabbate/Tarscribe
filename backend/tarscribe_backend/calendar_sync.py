"""CalDAV export for dated action items."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urljoin

import httpx
from sqlmodel import Session, select

from .models import ActionItem, Recording, Topic
from .settings_store import get_caldav_password, load_prefs

CALENDAR_MODE_OFF = "off"
CALENDAR_MODE_APPROVAL = "approval"
CALENDAR_MODE_AUTO = "auto"
CALENDAR_MODES = {CALENDAR_MODE_OFF, CALENDAR_MODE_APPROVAL, CALENDAR_MODE_AUTO}


def _ics_escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
    )


def _norm_text(text: str) -> str:
    return re.sub(r"\W+", " ", text.casefold()).strip()


def _action_uid(item: ActionItem) -> str:
    key = f"{item.recording_id}:{_norm_text(item.text)}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]
    return f"tarscribe-task-{digest}@tarscribe.app"


def _clean_collection_url(raw: str | None) -> str | None:
    url = (raw or "").strip()
    if not url:
        return None
    return url if url.endswith("/") else f"{url}/"


def _event_href(collection_url: str, uid: str) -> str:
    return urljoin(collection_url, quote(f"{uid}.ics", safe=""))


def _caldav_config(topic: Topic) -> tuple[str | None, str, str | None]:
    prefs = load_prefs()
    caldav = prefs.get("caldav") if isinstance(prefs.get("caldav"), dict) else {}
    url = _clean_collection_url(topic.calendar_url or caldav.get("url"))
    username = str(caldav.get("username") or "").strip()
    password = get_caldav_password()
    return url, username, password


def _auth(username: str, password: str | None) -> tuple[str, str] | None:
    if not username and not password:
        return None
    return (username, password or "")


def _valid_due_date(value: str | None):
    try:
        return datetime.strptime(value or "", "%Y-%m-%d").date()
    except ValueError:
        return None


def build_event_ics(item: ActionItem, rec: Recording, topic: Topic) -> str | None:
    day = _valid_due_date(item.due_date)
    if not day:
        return None
    end = day + timedelta(days=1)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    uid = item.calendar_uid or _action_uid(item)
    desc_parts = [f"Aufnahme: {rec.title}", f"Themenbereich: {topic.name}"]
    if item.assignee:
        desc_parts.insert(0, f"Verantwortlich: {item.assignee}")
    if item.due:
        desc_parts.append(f"Frist (Original): {item.due}")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Tarscribe//Aufgaben//DE",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{stamp}",
        f"DTSTART;VALUE=DATE:{day.strftime('%Y%m%d')}",
        f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}",
        f"SUMMARY:{_ics_escape(item.text)}",
        f"DESCRIPTION:{_ics_escape(' - '.join(desc_parts))}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines) + "\r\n"


def test_caldav_connection(url: str, username: str = "", password: str | None = None) -> dict:
    collection_url = _clean_collection_url(url)
    if not collection_url:
        return {"ok": False, "error": "Kalender-URL fehlt."}
    try:
        with httpx.Client(timeout=10, follow_redirects=True, auth=_auth(username, password)) as client:
            response = client.request(
                "PROPFIND",
                collection_url,
                headers={"Depth": "0", "Content-Type": "application/xml"},
                content=b'<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>',
            )
        if response.status_code < 400:
            return {"ok": True, "status": response.status_code}
        return {"ok": False, "status": response.status_code, "error": response.text[:300]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _mark(item: ActionItem, status: str, error: str | None = None) -> ActionItem:
    item.calendar_status = status
    item.calendar_error = error
    return item


def _delete_remote(item: ActionItem, topic: Topic) -> None:
    url, username, password = _caldav_config(topic)
    href = item.calendar_href
    if not href and url and item.calendar_uid:
        href = _event_href(url, item.calendar_uid)
    if not href:
        return
    with httpx.Client(timeout=10, follow_redirects=True, auth=_auth(username, password)) as client:
        response = client.delete(href)
    if response.status_code not in {200, 202, 204, 404, 410}:
        raise RuntimeError(f"CalDAV DELETE fehlgeschlagen: HTTP {response.status_code}")


def sync_action_item(
    session: Session,
    item: ActionItem,
    *,
    approved: bool = False,
) -> ActionItem:
    rec = session.get(Recording, item.recording_id)
    topic = session.get(Topic, rec.topic_id) if rec else None
    if not rec or not topic:
        return _mark(item, "failed", "Aufnahme oder Themenbereich nicht gefunden.")

    mode = topic.calendar_export_mode if topic.calendar_export_mode in CALENDAR_MODES else CALENDAR_MODE_OFF
    url, username, password = _caldav_config(topic)

    try:
        eligible = item.kind == "task" and not item.done and _valid_due_date(item.due_date) is not None
        if mode == CALENDAR_MODE_OFF or not eligible:
            if item.calendar_href:
                _delete_remote(item, topic)
            item.calendar_href = None
            item.calendar_etag = None
            item.calendar_exported_at = None
            return _mark(item, "skipped")

        if not url:
            return _mark(item, "not_configured", "CalDAV-Kalender-URL fehlt.")

        if mode == CALENDAR_MODE_APPROVAL and not approved and item.calendar_status != "synced":
            return _mark(item, "pending_approval")

        item.calendar_uid = item.calendar_uid or _action_uid(item)
        item.calendar_href = _event_href(url, item.calendar_uid)
        body = build_event_ics(item, rec, topic)
        if not body:
            return _mark(item, "skipped")

        with httpx.Client(timeout=10, follow_redirects=True, auth=_auth(username, password)) as client:
            response = client.put(
                item.calendar_href,
                content=body.encode("utf-8"),
                headers={"Content-Type": "text/calendar; charset=utf-8"},
            )
        if response.status_code not in {200, 201, 204}:
            return _mark(
                item,
                "failed",
                f"CalDAV PUT fehlgeschlagen: HTTP {response.status_code} {response.text[:200]}",
            )
        item.calendar_etag = response.headers.get("ETag")
        item.calendar_exported_at = datetime.now(timezone.utc)
        return _mark(item, "synced")
    except Exception as exc:  # noqa: BLE001
        return _mark(item, "failed", str(exc))


def sync_topic_action_items(session: Session, topic_id: int, *, approved: bool = False) -> int:
    rows = session.exec(
        select(ActionItem, Recording)
        .join(Recording, ActionItem.recording_id == Recording.id)
        .where(Recording.topic_id == topic_id)
    ).all()
    count = 0
    for item, _rec in rows:
        sync_action_item(session, item, approved=approved)
        session.add(item)
        count += 1
    return count

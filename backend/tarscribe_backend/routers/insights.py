"""Derived insights: action items, auto-chapters, and speaker statistics."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..calendar_sync import sync_action_item
from ..db import get_session
from ..models import (
    ActionItem,
    Chapter,
    Digest,
    DiarizationRun,
    KnownSpeaker,
    Recording,
    RecordingStatus,
    Segment,
    SpeakerLabel,
    Summary,
    ThreadMention,
    Transcript,
    Topic,
    TopicThread,
    Word,
)
from ..overlay import load_overlay
from ..settings_store import load_prefs

router = APIRouter(prefix="/api", tags=["insights"])

THREAD_STOPWORDS = {
    "der",
    "die",
    "das",
    "ein",
    "eine",
    "und",
    "oder",
    "mit",
    "zum",
    "zur",
    "für",
    "von",
    "im",
    "im",
    "am",
    "the",
    "and",
    "for",
    "with",
    # Structural chapter words — recurring meeting scaffolding, not a topic.
    "begrüßung",
    "begrüssung",
    "einleitung",
    "einführung",
    "einstieg",
    "abschluss",
    "verabschiedung",
    "ausblick",
    "organisatorisches",
    "vorstellung",
    # Session formats — apply to every subject, so useless as a topic label.
    "vorlesung",
    "vorlesungen",
    "übung",
    "übungen",
    "seminar",
    "tutorium",
    "sitzung",
    "besprechung",
    "meeting",
}

# Minimum keyword length to be considered topical (drops short connectives).
THREAD_KEYWORD_MIN_LEN = 4


def _get_recording(session: Session, recording_id: int) -> Recording:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    return rec


# ── Action items ─────────────────────────────────────────────────────────────

class ActionItemPatch(BaseModel):
    done: bool | None = None
    text: str | None = None
    assignee: str | None = None
    due: str | None = None
    # ISO date (YYYY-MM-DD); empty string clears the due date.
    due_date: str | None = None
    include_in_tasks: bool | None = None


class ActionItemExtractIn(BaseModel):
    clarification: str | None = Field(default=None, max_length=4000)


def _norm_name(s: str) -> str:
    return re.sub(r"\W+", " ", s.lower()).strip()


def my_speaker_name(session: Session) -> str | None:
    """Name of the known speaker the user marked as "me" (None if unset)."""
    sid = load_prefs().get("my_speaker_id") or None
    if not sid:
        return None
    sp = session.get(KnownSpeaker, int(sid))
    return sp.name if sp else None


def _is_mine(assignee: str | None, my_name: str | None) -> bool:
    """Whether an action item's assignee refers to the configured "me" speaker.

    Name-based: exact match, a single first name matching mine, or my full name
    contained in the assignee string. Conservative to avoid grabbing others' tasks.
    """
    if not assignee or not my_name:
        return False
    a = _norm_name(assignee)
    n = _norm_name(my_name)
    if not a or not n:
        return False
    if a == n:
        return True
    a_tokens = a.split()
    n_tokens = n.split()
    if len(a_tokens) == 1 and n_tokens and a_tokens[0] == n_tokens[0]:
        return True
    return set(n_tokens) <= set(a_tokens)


def _item_dict(
    item: ActionItem,
    rec: Recording | None = None,
    topic: Topic | None = None,
    my_name: str | None = None,
) -> dict:
    return {
        "id": item.id,
        "recording_id": item.recording_id,
        "kind": item.kind,
        "text": item.text,
        "assignee": item.assignee,
        "due": item.due,
        "due_date": item.due_date,
        "done": item.done,
        "include_in_tasks": item.include_in_tasks,
        "calendar_status": item.calendar_status,
        "calendar_error": item.calendar_error,
        "calendar_exported_at": item.calendar_exported_at.isoformat()
        if item.calendar_exported_at
        else None,
        "is_mine": _is_mine(item.assignee, my_name),
        "created_at": item.created_at.isoformat(),
        "recording_title": rec.title if rec else None,
        "topic_id": rec.topic_id if rec else None,
        "topic_name": topic.name if topic else None,
        "topic_color": topic.color if topic else None,
    }


@router.post("/recordings/{recording_id}/action-items/extract")
def extract_action_items(
    recording_id: int,
    payload: ActionItemExtractIn | None = None,
    session: Session = Depends(get_session),
) -> dict:
    _get_recording(session, recording_id)
    from ..jobs import enqueue_action_items

    clarification = (payload.clarification or "").strip() if payload else ""
    job_id = enqueue_action_items(recording_id, clarification or None)
    return {"job_id": job_id, "status": "pending"}


@router.get("/recordings/{recording_id}/action-items")
def list_recording_action_items(
    recording_id: int, session: Session = Depends(get_session)
) -> list[dict]:
    _get_recording(session, recording_id)
    items = session.exec(
        select(ActionItem)
        .where(ActionItem.recording_id == recording_id)
        .order_by(ActionItem.id)
    ).all()
    my_name = my_speaker_name(session)
    return [_item_dict(i, my_name=my_name) for i in items]


@router.get("/action-items")
def list_action_items(
    topic_id: int | None = None,
    done: bool | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """All action items across recordings, newest recording first."""
    stmt = (
        select(ActionItem, Recording, Topic)
        .join(Recording, ActionItem.recording_id == Recording.id)
        .join(Topic, Recording.topic_id == Topic.id)
        .order_by(Recording.created_at.desc(), ActionItem.id)
    )
    if topic_id is not None:
        stmt = stmt.where(Recording.topic_id == topic_id)
    if done is not None:
        stmt = stmt.where(ActionItem.done == done)  # noqa: E712
    rows = session.exec(stmt).all()
    my_name = my_speaker_name(session)
    return [_item_dict(item, rec, topic, my_name) for item, rec, topic in rows]


@router.patch("/action-items/{item_id}")
def update_action_item(
    item_id: int, payload: ActionItemPatch, session: Session = Depends(get_session)
) -> dict:
    item = session.get(ActionItem, item_id)
    if not item:
        raise HTTPException(404, "Eintrag nicht gefunden")
    data = payload.model_dump(exclude_unset=True)
    if "due_date" in data:
        # Normalize: empty string clears the date.
        data["due_date"] = (data["due_date"] or "").strip() or None
    for key, value in data.items():
        setattr(item, key, value)
    if any(key in data for key in ("done", "text", "assignee", "due", "due_date")):
        sync_action_item(session, item)
    session.add(item)
    session.commit()
    session.refresh(item)
    return _item_dict(item, my_name=my_speaker_name(session))


@router.post("/action-items/{item_id}/calendar-sync")
def sync_action_item_calendar(item_id: int, session: Session = Depends(get_session)) -> dict:
    item = session.get(ActionItem, item_id)
    if not item:
        raise HTTPException(404, "Eintrag nicht gefunden")
    sync_action_item(session, item, approved=True)
    session.add(item)
    session.commit()
    session.refresh(item)
    return _item_dict(item, my_name=my_speaker_name(session))


@router.delete("/action-items/{item_id}", status_code=204)
def delete_action_item(item_id: int, session: Session = Depends(get_session)) -> None:
    item = session.get(ActionItem, item_id)
    if not item:
        raise HTTPException(404, "Eintrag nicht gefunden")
    if item.calendar_href:
        item.done = True
        sync_action_item(session, item, approved=True)
    session.delete(item)
    session.commit()


def _ics_escape(text: str) -> str:
    """Escape a value for an iCalendar text field (RFC 5545)."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


@router.get("/action-items/export.ics")
def export_action_items_ics(
    topic_id: int | None = None, session: Session = Depends(get_session)
):
    """Open tasks with a due date as an iCalendar (all-day events) for any calendar app."""
    stmt = (
        select(ActionItem, Recording, Topic)
        .join(Recording, ActionItem.recording_id == Recording.id)
        .join(Topic, Recording.topic_id == Topic.id)
        .where(ActionItem.done == False, ActionItem.due_date != None)  # noqa: E711,E712
        .order_by(ActionItem.due_date)
    )
    if topic_id is not None:
        stmt = stmt.where(Recording.topic_id == topic_id)
    rows = session.exec(stmt).all()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Tarscribe//Aufgaben//DE",
        "CALSCALE:GREGORIAN",
    ]
    exported = 0
    for item, rec, topic in rows:
        try:
            day = datetime.strptime(item.due_date, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        end = day + timedelta(days=1)
        desc_parts = [f"Aufnahme: {rec.title}", f"Themenbereich: {topic.name}"]
        if item.assignee:
            desc_parts.insert(0, f"Verantwortlich: {item.assignee}")
        if item.due:
            desc_parts.append(f"Frist (Original): {item.due}")
        lines += [
            "BEGIN:VEVENT",
            f"UID:tarscribe-task-{item.id}@tarscribe.app",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{day.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}",
            f"SUMMARY:{_ics_escape(item.text)}",
            f"DESCRIPTION:{_ics_escape(' — '.join(desc_parts))}",
            "END:VEVENT",
        ]
        exported += 1
    lines.append("END:VCALENDAR")

    if exported == 0:
        raise HTTPException(404, "Keine offenen Aufgaben mit Fälligkeitsdatum gefunden.")

    headers = {"Content-Disposition": 'attachment; filename="Tarscribe Aufgaben.ics"'}
    return PlainTextResponse(
        "\r\n".join(lines), media_type="text/calendar", headers=headers
    )


# ── Chapters ─────────────────────────────────────────────────────────────────

def _chapter_dict(ch: Chapter) -> dict:
    return {
        "id": ch.id,
        "recording_id": ch.recording_id,
        "idx": ch.idx,
        "start": ch.start,
        "end": ch.end,
        "title": ch.title,
    }


@router.post("/recordings/{recording_id}/chapters/generate")
def generate_chapters(recording_id: int, session: Session = Depends(get_session)) -> dict:
    _get_recording(session, recording_id)
    from ..jobs import enqueue_chapters

    job_id = enqueue_chapters(recording_id)
    return {"job_id": job_id, "status": "pending"}


@router.get("/recordings/{recording_id}/chapters")
def list_chapters(recording_id: int, session: Session = Depends(get_session)) -> list[dict]:
    _get_recording(session, recording_id)
    chapters = session.exec(
        select(Chapter).where(Chapter.recording_id == recording_id).order_by(Chapter.idx)
    ).all()
    return [_chapter_dict(c) for c in chapters]


@router.delete("/recordings/{recording_id}/chapters", status_code=204)
def delete_chapters(recording_id: int, session: Session = Depends(get_session)) -> None:
    _get_recording(session, recording_id)
    for ch in session.exec(
        select(Chapter).where(Chapter.recording_id == recording_id)
    ).all():
        session.delete(ch)
    session.commit()


def _yt_ts(sec: float) -> str:
    t = int(sec)
    h, t = divmod(t, 3600)
    m, s = divmod(t, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _srt_ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


@router.get("/recordings/{recording_id}/chapters/export")
def export_chapters(
    recording_id: int, format: str = "youtube", session: Session = Depends(get_session)
):
    rec = _get_recording(session, recording_id)
    chapters = session.exec(
        select(Chapter).where(Chapter.recording_id == recording_id).order_by(Chapter.idx)
    ).all()
    if not chapters:
        raise HTTPException(404, "Keine Kapitel vorhanden")

    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in rec.title).strip() or "Kapitel"
    fmt = format.lower()
    if fmt == "youtube":
        body = "\n".join(f"{_yt_ts(c.start)} {c.title}" for c in chapters)
        headers = {"Content-Disposition": f'attachment; filename="{safe} Kapitel.txt"'}
        return PlainTextResponse(body, headers=headers)
    if fmt == "srt":
        lines: list[str] = []
        for i, c in enumerate(chapters, 1):
            end = c.end if c.end is not None else rec.duration_sec
            lines += [str(i), f"{_srt_ts(c.start)} --> {_srt_ts(end)}", c.title, ""]
        headers = {"Content-Disposition": f'attachment; filename="{safe} Kapitel.srt"'}
        return PlainTextResponse("\n".join(lines), headers=headers)
    raise HTTPException(400, f"Unbekanntes Format: {format}")


# ── Cross-recording threads ──────────────────────────────────────────────────

def _thread_keywords(title: str) -> dict[str, str]:
    """Significant topical keywords in a chapter title.

    Returns a ``{lowercased: display}`` map so each keyword keeps the original
    casing of its first occurrence for the thread title. De-duplicated per title
    so a word repeated within one chapter still counts once.
    """
    keywords: dict[str, str] = {}
    for word in re.findall(r"[a-zA-ZäöüÄÖÜß0-9]+", title):
        low = word.lower()
        if low in THREAD_STOPWORDS or len(low) < THREAD_KEYWORD_MIN_LEN:
            continue
        keywords.setdefault(low, word)
    return keywords


def _mention_dict(
    mention: ThreadMention,
    rec: Recording | None,
    topic: Topic | None,
) -> dict:
    return {
        "id": mention.id,
        "thread_id": mention.thread_id,
        "recording_id": mention.recording_id,
        "recording_title": rec.title if rec else None,
        "topic_id": rec.topic_id if rec else None,
        "topic_name": topic.name if topic else None,
        "topic_color": topic.color if topic else None,
        "start_sec": mention.start_sec,
        "text": mention.text,
        "created_at": _iso(mention.created_at),
        "recording_created_at": _iso(rec.created_at) if rec else None,
    }


def _thread_dict(thread: TopicThread, mentions: list[dict]) -> dict:
    return {
        "id": thread.id,
        "title": thread.title,
        "updated_at": _iso(thread.updated_at),
        "created_at": _iso(thread.created_at),
        "mention_count": len(mentions),
        "recording_count": len({m["recording_id"] for m in mentions}),
        "mentions": mentions,
    }


@router.post("/threads/rebuild")
def rebuild_threads(session: Session = Depends(get_session)) -> dict:
    """Cluster chapters into recurring threads by shared topical keyword.

    Chapter titles are LLM-generated and essentially never match verbatim across
    recordings, so we group on individual significant keywords instead. Keywords
    that connect ≥2 distinct recordings become threads; the strongest (most
    connecting) keyword claims its chapters first so each chapter lands in a
    single thread.
    """
    for mention in session.exec(select(ThreadMention)).all():
        session.delete(mention)
    for thread in session.exec(select(TopicThread)).all():
        session.delete(thread)
    session.commit()

    chapters = session.exec(select(Chapter).order_by(Chapter.recording_id, Chapter.idx)).all()
    recordings = {
        rec.id: rec
        for rec in session.exec(select(Recording)).all()
        if rec.id is not None
    }

    # keyword -> chapters mentioning it (only chapters with a known recording).
    keyword_chapters: dict[str, list[Chapter]] = defaultdict(list)
    keyword_display: dict[str, str] = {}
    for chapter in chapters:
        if chapter.recording_id not in recordings:
            continue
        for low, display in _thread_keywords(chapter.title).items():
            keyword_chapters[low].append(chapter)
            keyword_display.setdefault(low, display)

    def recording_span(keyword: str) -> int:
        return len({c.recording_id for c in keyword_chapters[keyword]})

    # Strongest keyword first; ties broken by chapter count then alphabetically
    # for deterministic output.
    ranked = sorted(
        (kw for kw in keyword_chapters if recording_span(kw) >= 2),
        key=lambda kw: (-recording_span(kw), -len(keyword_chapters[kw]), kw),
    )

    used_chapter_ids: set[int] = set()
    created = 0
    mentions_created = 0
    for keyword in ranked:
        grouped = [c for c in keyword_chapters[keyword] if c.id not in used_chapter_ids]
        # A stronger thread may have already claimed enough chapters to drop this
        # one below the cross-recording threshold.
        if len({c.recording_id for c in grouped}) < 2:
            continue
        updated_at = max(recordings[c.recording_id].created_at for c in grouped)
        thread = TopicThread(
            title=keyword_display[keyword].capitalize(),
            updated_at=updated_at,
        )
        session.add(thread)
        session.flush()
        created += 1
        for chapter in grouped:
            used_chapter_ids.add(chapter.id)
            session.add(
                ThreadMention(
                    thread_id=thread.id,
                    recording_id=chapter.recording_id,
                    chapter_id=chapter.id,
                    start_sec=chapter.start,
                    text=chapter.title,
                    created_at=recordings[chapter.recording_id].created_at,
                )
            )
            mentions_created += 1
    session.commit()
    return {"threads": created, "mentions": mentions_created}


def _load_thread_payload(
    session: Session, thread_filter: int | None = None, recording_filter: int | None = None
) -> list[dict]:
    threads = session.exec(select(TopicThread).order_by(TopicThread.updated_at.desc())).all()
    if thread_filter is not None:
        threads = [thread for thread in threads if thread.id == thread_filter]
    payload = []
    for thread in threads:
        stmt = select(ThreadMention).where(ThreadMention.thread_id == thread.id)
        if recording_filter is not None:
            stmt = stmt.where(ThreadMention.recording_id == recording_filter)
        mentions = session.exec(stmt.order_by(ThreadMention.created_at.desc())).all()
        if not mentions:
            continue
        rec_ids = {m.recording_id for m in mentions}
        recordings = {
            rec.id: rec
            for rec in session.exec(select(Recording).where(Recording.id.in_(rec_ids))).all()
            if rec.id is not None
        }
        topic_ids = {rec.topic_id for rec in recordings.values()}
        topics = {
            topic.id: topic
            for topic in session.exec(select(Topic).where(Topic.id.in_(topic_ids))).all()
            if topic.id is not None
        }
        mention_payload = [
            _mention_dict(m, recordings.get(m.recording_id), topics.get(recordings[m.recording_id].topic_id) if m.recording_id in recordings else None)
            for m in mentions
        ]
        payload.append(_thread_dict(thread, mention_payload))
    return payload


@router.get("/threads")
def list_threads(session: Session = Depends(get_session)) -> list[dict]:
    return _load_thread_payload(session)


@router.get("/recordings/{recording_id}/threads")
def list_recording_threads(recording_id: int, session: Session = Depends(get_session)) -> list[dict]:
    _get_recording(session, recording_id)
    return _load_thread_payload(session, recording_filter=recording_id)


# ── Weekly digest ────────────────────────────────────────────────────────────

DIGEST_MAX_DAYS = 31


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _digest_dict(digest: Digest) -> dict:
    return {
        "id": digest.id,
        "date_from": _iso(digest.date_from),
        "date_to": _iso(digest.date_to),
        "content_markdown": digest.content_markdown,
        "model": digest.model,
        "recording_count": digest.recording_count,
        "created_at": _iso(digest.created_at),
    }


def _safe_digest_filename(digest: Digest) -> str:
    date_from = digest.date_from.strftime("%Y-%m-%d")
    date_to = digest.date_to.strftime("%Y-%m-%d")
    return f"Tarscribe Wochen-Digest {date_from} bis {date_to}.md"


def _short(text: str, limit: int) -> str:
    cleaned = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rsplit(" ", 1)[0].rstrip() + " ..."


def _transcript_excerpt(session: Session, recording_id: int, limit: int = 2200) -> str:
    transcript = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).first()
    if not transcript:
        return ""
    words = session.exec(
        select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
    ).all()
    text = "".join(w.text for w in words).strip()
    return _short(text, limit)


def _speaker_digest_line(session: Session, recording_id: int) -> str:
    run = session.exec(
        select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id,
            DiarizationRun.is_active == True,  # noqa: E712
        )
    ).first()
    if not run:
        return ""
    segments = session.exec(
        select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)
    ).all()
    relabel, _reassigns = load_overlay(session, recording_id)
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}
    totals: dict[str, float] = {}
    for seg in segments:
        if seg.end <= seg.start:
            continue
        label = relabel.get(seg.speaker_label, seg.speaker_label)
        totals[label] = totals.get(label, 0.0) + (seg.end - seg.start)
    total = sum(totals.values())
    if total <= 0:
        return ""
    parts = []
    for label, sec in sorted(totals.items(), key=lambda item: item[1], reverse=True)[:5]:
        name = name_map.get(label, label)
        parts.append(f"{name} {round(sec / total * 100)}%")
    return "Sprechanteile: " + ", ".join(parts)


def _recording_digest_entry(session: Session, rec: Recording) -> str:
    topic = session.get(Topic, rec.topic_id)
    summaries = session.exec(
        select(Summary)
        .where(Summary.recording_id == rec.id, Summary.content != "")
        .order_by(Summary.created_at.desc())
    ).all()
    source_label = "Zusammenfassung"
    source_text = _short(summaries[0].content, 2600) if summaries else ""
    if not source_text:
        source_label = "Transkript-Auszug"
        source_text = _transcript_excerpt(session, rec.id)
    if not source_text:
        return ""

    actions = session.exec(
        select(ActionItem).where(ActionItem.recording_id == rec.id).order_by(ActionItem.id)
    ).all()
    action_lines = []
    for item in actions:
        if item.kind == "decision":
            action_lines.append(f"- Entscheidung: {item.text}")
        elif not item.done:
            suffix = ""
            if item.assignee:
                suffix += f" | verantwortlich: {item.assignee}"
            if item.due:
                suffix += f" | Frist: {item.due}"
            action_lines.append(f"- Offen: {item.text}{suffix}")
    speakers = _speaker_digest_line(session, rec.id)

    parts = [
        f"### {rec.created_at.strftime('%Y-%m-%d')} · {rec.title}",
        f"Themenbereich: {topic.name if topic else 'Unbekannt'}",
        f"{source_label}:\n{source_text}",
    ]
    if action_lines:
        parts.append("Aufgaben/Entscheidungen:\n" + "\n".join(action_lines[:12]))
    if speakers:
        parts.append(speakers)
    return "\n\n".join(parts)


def _generate_digest_markdown(
    *,
    date_from: datetime,
    date_to: datetime,
    recording_count: int,
    context: str,
    chunk_size: int,
) -> tuple[str, str]:
    from .. import agent as AG
    from .. import llm as L

    cfg = L.get_llm_config("summaries")
    if not cfg["model"]:
        raise HTTPException(
            400,
            "Kein Chat-Modell gewählt. Bitte in den Einstellungen Anbieter/Endpoint und Modell konfigurieren.",
        )

    budget = max(6000, chunk_size - 5000)
    if len(context) > budget:
        context = context[:budget].rsplit("\n", 1)[0].rstrip() + "\n\n[Quellen gekürzt]"

    user = f"""Erstelle einen Wochen-Digest als Markdown.

Zeitraum: {date_from.strftime('%d.%m.%Y')} bis {date_to.strftime('%d.%m.%Y')}
Anzahl berücksichtigter Aufnahmen: {recording_count}

Gewünschte Struktur:
# Deine Woche
## Kurzüberblick
## Besprochene Themen
## Entscheidungen
## Offene Aufgaben
## Sprecher & Dynamik
## Nächste Schritte

Regeln:
- Schreibe präzise, knapp und ohne erfundene Inhalte.
- Entscheidungen und Aufgaben nur übernehmen, wenn sie in den Quellen stehen.
- Aufgaben als Markdown-Checkliste ausgeben.
- Wenn ein Abschnitt keine belastbaren Daten hat, schreibe einen kurzen Satz dazu.

Quellen:
{context}"""

    system_content = (
        "Du schreibst deutschsprachige Wochen-Digests aus Meeting- und Notizdaten. "
        "Du bist nüchtern, konkret und zitierst keine erfundenen Fakten."
    )
    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": user},
    ]

    # Agentic RAG: let the LLM iteratively search the knowledge base before
    # generating the digest. Falls back to plain digest on any failure.
    agent_cfg = AG.get_agent_rag_config("summaries")
    if agent_cfg["enabled"] and agent_cfg["rag_enabled"] and agent_cfg["model"]:
        try:
            from ..db import session_scope

            with session_scope() as s:
                research_notes, _sources = AG.research_context_sync(
                    session=s,
                    topic_id=None,
                    recording_id=None,
                    task_description=(
                        f"Wochen-Digest für {date_from.strftime('%d.%m.%Y')} bis "
                        f"{date_to.strftime('%d.%m.%Y')} aus {recording_count} Aufnahmen"
                    ),
                    messages_seed=messages,
                    cfg=agent_cfg,
                )
            if research_notes:
                messages[0] = {
                    **messages[0],
                    "content": system_content
                    + "\n\n--- Recherchierter Kontext ---\n"
                    + research_notes,
                }
        except AG.ToolSupportError:
            pass
        except Exception:  # noqa: BLE001
            pass

    try:
        content = "".join(
            L.stream_chat(
                messages,
                cfg["model"],
                cfg["base_url"],
                temperature=cfg.get("temperature", 0.25),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=cfg.get("reasoning_effort"),
                provider=cfg.get("provider"),
            )
        ).strip()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Digest konnte nicht erstellt werden: {exc}") from exc
    if not content:
        raise HTTPException(502, "Das LLM hat keinen Digest zurückgegeben.")
    return content, cfg["model"]


@router.post("/digests")
def create_digest(days: int = 7, session: Session = Depends(get_session)) -> dict:
    if days < 1 or days > DIGEST_MAX_DAYS:
        raise HTTPException(400, f"days muss zwischen 1 und {DIGEST_MAX_DAYS} liegen")

    date_to = datetime.now(timezone.utc)
    date_from = date_to - timedelta(days=days)
    recordings = session.exec(
        select(Recording)
        .where(
            Recording.created_at >= date_from,
            Recording.created_at <= date_to,
            Recording.status == RecordingStatus.ready,
        )
        .order_by(Recording.created_at)
    ).all()
    entries = [entry for rec in recordings if (entry := _recording_digest_entry(session, rec))]
    if not entries:
        raise HTTPException(400, "Keine transkribierten Aufnahmen im gewählten Zeitraum gefunden.")

    from .. import llm as L
    from ..settings_store import load_prefs

    chunk_size = int(load_prefs().get("llm_chunk_size") or L.CHAR_BUDGET)
    content, model = _generate_digest_markdown(
        date_from=date_from,
        date_to=date_to,
        recording_count=len(entries),
        context="\n\n---\n\n".join(entries),
        chunk_size=chunk_size,
    )
    digest = Digest(
        date_from=date_from,
        date_to=date_to,
        content_markdown=content,
        model=model,
        recording_count=len(entries),
    )
    session.add(digest)
    session.commit()
    session.refresh(digest)
    return _digest_dict(digest)


@router.get("/digests")
def list_digests(session: Session = Depends(get_session)) -> list[dict]:
    digests = session.exec(select(Digest).order_by(Digest.created_at.desc())).all()
    return [_digest_dict(d) for d in digests]


@router.get("/digests/{digest_id}")
def get_digest(digest_id: int, session: Session = Depends(get_session)) -> dict:
    digest = session.get(Digest, digest_id)
    if not digest:
        raise HTTPException(404, "Digest nicht gefunden")
    return _digest_dict(digest)


@router.post("/digests/{digest_id}/send-to-folder")
def send_digest_to_folder(digest_id: int, session: Session = Depends(get_session)) -> dict:
    digest = session.get(Digest, digest_id)
    if not digest:
        raise HTTPException(404, "Digest nicht gefunden")

    from ..settings_store import load_prefs

    export_path = str(load_prefs().get("digest_export_path") or "").strip()
    if not export_path:
        raise HTTPException(400, "Für Wochen-Digests ist kein Export-Ordner gesetzt.")
    folder = Path(export_path).expanduser()
    if not folder.is_dir():
        raise HTTPException(400, f"Ordner existiert nicht: {folder}")

    target = folder / _safe_digest_filename(digest)
    try:
        target.write_text(digest.content_markdown, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(500, f"Schreiben fehlgeschlagen: {exc}") from exc
    return {"path": str(target)}


# ── Speaker statistics ───────────────────────────────────────────────────────

TIMELINE_MAX_BUCKETS = 120


@router.get("/recordings/{recording_id}/speaker-stats")
def speaker_stats(recording_id: int, session: Session = Depends(get_session)) -> dict:
    """Talk shares, interruptions and a per-speaker talk-time timeline.

    Computed from the active diarization run with merge edits (overlay) and
    display names applied.
    """
    rec = _get_recording(session, recording_id)
    run = session.exec(
        select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id,
            DiarizationRun.is_active == True,  # noqa: E712
        )
    ).first()
    if not run:
        raise HTTPException(404, "Keine Sprechererkennung vorhanden")
    segments = session.exec(
        select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)
    ).all()
    relabel, _reassigns = load_overlay(session, recording_id)
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}

    duration = max(rec.duration_sec, max((s.end for s in segments), default=0.0))
    spans = [
        (s.start, s.end, relabel.get(s.speaker_label, s.speaker_label))
        for s in segments
        if s.end > s.start
    ]

    by_label: dict[str, dict] = {}
    for start, end, label in spans:
        st = by_label.setdefault(
            label,
            {"talk_sec": 0.0, "segments": 0, "longest_sec": 0.0,
             "interruptions_made": 0, "interruptions_received": 0},
        )
        st["talk_sec"] += end - start
        st["segments"] += 1
        st["longest_sec"] = max(st["longest_sec"], end - start)

    # B interrupts A when B starts while A (another speaker) is still talking.
    for i, (a_start, a_end, a_label) in enumerate(spans):
        for b_start, _b_end, b_label in spans[i + 1 :]:
            if b_start >= a_end:
                break
            if b_label != a_label and b_start > a_start:
                by_label[b_label]["interruptions_made"] += 1
                by_label[a_label]["interruptions_received"] += 1

    total_talk = sum(st["talk_sec"] for st in by_label.values()) or 1.0

    # Timeline: per-speaker talk seconds in fixed buckets across the recording.
    n_buckets = max(1, min(TIMELINE_MAX_BUCKETS, int(duration // 5) or 1))
    bucket_sec = duration / n_buckets if duration > 0 else 1.0
    timeline: dict[str, list[float]] = {label: [0.0] * n_buckets for label in by_label}
    for start, end, label in spans:
        first = min(int(start / bucket_sec), n_buckets - 1)
        last = min(int(end / bucket_sec), n_buckets - 1)
        for b in range(first, last + 1):
            b_start, b_end = b * bucket_sec, (b + 1) * bucket_sec
            overlap = min(end, b_end) - max(start, b_start)
            if overlap > 0:
                timeline[label][b] += overlap

    speakers = [
        {
            "label": label,
            "name": name_map.get(label, label),
            "talk_sec": round(st["talk_sec"], 2),
            "share": round(st["talk_sec"] / total_talk, 4),
            "segments": st["segments"],
            "longest_sec": round(st["longest_sec"], 2),
            "interruptions_made": st["interruptions_made"],
            "interruptions_received": st["interruptions_received"],
            "timeline": [round(v, 2) for v in timeline[label]],
        }
        for label, st in by_label.items()
    ]
    speakers.sort(key=lambda s: -s["talk_sec"])

    return {
        "recording_id": recording_id,
        "duration_sec": duration,
        "total_talk_sec": round(sum(st["talk_sec"] for st in by_label.values()), 2),
        "bucket_sec": round(bucket_sec, 3),
        "num_buckets": n_buckets,
        "speakers": speakers,
    }

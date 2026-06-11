"""Derived insights: action items, auto-chapters, and speaker statistics."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import (
    ActionItem,
    Chapter,
    DiarizationRun,
    Recording,
    Segment,
    SpeakerLabel,
    Topic,
)
from ..overlay import load_overlay
from ..security import require_token

router = APIRouter(prefix="/api", tags=["insights"], dependencies=[Depends(require_token)])


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


def _item_dict(item: ActionItem, rec: Recording | None = None, topic: Topic | None = None) -> dict:
    return {
        "id": item.id,
        "recording_id": item.recording_id,
        "kind": item.kind,
        "text": item.text,
        "assignee": item.assignee,
        "due": item.due,
        "done": item.done,
        "created_at": item.created_at.isoformat(),
        "recording_title": rec.title if rec else None,
        "topic_id": rec.topic_id if rec else None,
        "topic_name": topic.name if topic else None,
        "topic_color": topic.color if topic else None,
    }


@router.post("/recordings/{recording_id}/action-items/extract")
def extract_action_items(recording_id: int, session: Session = Depends(get_session)) -> dict:
    _get_recording(session, recording_id)
    from ..jobs import enqueue_action_items

    job_id = enqueue_action_items(recording_id)
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
    return [_item_dict(i) for i in items]


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
    return [_item_dict(item, rec, topic) for item, rec, topic in rows]


@router.patch("/action-items/{item_id}")
def update_action_item(
    item_id: int, payload: ActionItemPatch, session: Session = Depends(get_session)
) -> dict:
    item = session.get(ActionItem, item_id)
    if not item:
        raise HTTPException(404, "Eintrag nicht gefunden")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(item, key, value)
    session.add(item)
    session.commit()
    session.refresh(item)
    return _item_dict(item)


@router.delete("/action-items/{item_id}", status_code=204)
def delete_action_item(item_id: int, session: Session = Depends(get_session)) -> None:
    item = session.get(ActionItem, item_id)
    if not item:
        raise HTTPException(404, "Eintrag nicht gefunden")
    session.delete(item)
    session.commit()


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

"""Export a recording's transcript in TXT / SRT / VTT / JSON, with speakers."""

from __future__ import annotations

import json as jsonlib
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlmodel import Session, select

from ..db import get_session
from ..ml.alignment import build_utterances, chunk_cues, word_speakers
from ..ml.diarization import SpeakerSegment
from ..models import (
    DiarizationRun,
    Recording,
    Segment,
    SpeakerLabel,
    Summary,
    Topic,
)
from ..overlay import load_overlay
from ..transcript_view import load_effective_words
from ..upload_security import UploadPathForbidden, require_child_path

router = APIRouter(prefix="/api/recordings", tags=["export"])


def _ts(seconds: float, comma: bool) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _load(session: Session, recording_id: int):
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    loaded = load_effective_words(session, recording_id)
    words = loaded[1] if loaded else []
    run = session.exec(
        select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id, DiarizationRun.is_active == True  # noqa: E712
        )
    ).first()
    segments = (
        session.exec(select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)).all()
        if run
        else []
    )
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}
    return rec, words, segments, name_map


def _utterances(session: Session, recording_id: int, words, segments):
    aligned = [SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker_label) for s in segments]
    relabel, reassigns = load_overlay(session, recording_id)
    return build_utterances(words, aligned, reassigns, relabel)


def _mark_exported(session: Session, rec: Recording) -> None:
    rec.exported_at = datetime.now(timezone.utc)
    session.add(rec)
    session.commit()


@router.get("/{recording_id}/export")
def export(
    recording_id: int, format: str = "txt", session: Session = Depends(get_session)
):
    rec, words, segments, name_map = _load(session, recording_id)
    if not words:
        raise HTTPException(404, "Noch kein Transkript vorhanden")

    fmt = format.lower()
    diarized = bool(segments)
    utterances = _utterances(session, recording_id, words, segments) if diarized else []

    def name(label: str) -> str:
        return name_map.get(label, label)

    if fmt == "txt":
        if diarized:
            body = "\n\n".join(f"{name(u.speaker)}: {u.text}" for u in utterances)
        else:
            body = "".join(w.text for w in words).strip()
        _mark_exported(session, rec)
        return PlainTextResponse(body, headers=_dl(rec.title, "txt"))

    if fmt in ("srt", "vtt"):
        if diarized:
            aligned = [
                SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker_label) for s in segments
            ]
            relabel, reassigns = load_overlay(session, recording_id)
            spk = word_speakers(words, aligned, reassigns, relabel)
            cues = [
                (cs, ce, f"{name(csp)}: {ctext}")
                for cs, ce, csp, ctext in chunk_cues(words, spk)
            ]
        else:
            cues = [
                (cs, ce, ctext)
                for cs, ce, _sp, ctext in chunk_cues(words, ["S"] * len(words))
            ]
        comma = fmt == "srt"
        lines: list[str] = []
        if fmt == "vtt":
            lines.append("WEBVTT\n")
        for i, (start, end, text) in enumerate(cues, 1):
            if fmt == "srt":
                lines.append(str(i))
            lines.append(f"{_ts(start, comma)} --> {_ts(end, comma)}")
            lines.append(text)
            lines.append("")
        _mark_exported(session, rec)
        return PlainTextResponse("\n".join(lines), headers=_dl(rec.title, fmt))

    if fmt == "json":
        payload = {
            "title": rec.title,
            "duration_sec": rec.duration_sec,
            "language": rec.language,
            "words": [
                {
                    "start": w.start,
                    "end": w.end,
                    "text": w.text,
                    "raw_text": w.raw_text,
                    "corrected": w.correction_id is not None,
                }
                for w in words
            ],
            "speakers": sorted({name(s.speaker_label) for s in segments}),
            "utterances": [
                {"speaker": name(u.speaker), "start": u.start, "end": u.end, "text": u.text}
                for u in utterances
            ],
        }
        _mark_exported(session, rec)
        return PlainTextResponse(
            jsonlib.dumps(payload, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers=_dl(rec.title, "json"),
        )

    raise HTTPException(400, f"Unbekanntes Format: {format}")


def _dl(title: str, ext: str) -> dict:
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip() or "transcript"
    return {"Content-Disposition": f'attachment; filename="{safe}.{ext}"'}


def _safe_filename(title: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip() or "Aufnahme"


def _fmt_dur(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _fmt_ts(sec: float) -> str:
    """Format seconds as MM:SS or HH:MM:SS for transcript timestamps."""
    t = int(sec)
    h, t = divmod(t, 3600)
    m, s = divmod(t, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _build_markdown(session: Session, rec: Recording, words, segments, name_map) -> str:
    """Obsidian-friendly note: YAML frontmatter + summary callout + speaker transcript."""
    diarized = bool(segments)
    utterances = _utterances(session, rec.id, words, segments) if diarized else []
    speakers = sorted({name_map.get(s.speaker_label, s.speaker_label) for s in segments})

    summary = session.exec(
        select(Summary)
        .where(Summary.recording_id == rec.id, Summary.content != "")
        .order_by(Summary.created_at.desc())
    ).first()

    date_iso = rec.created_at.strftime("%Y-%m-%d") if rec.created_at else ""
    duration = _fmt_dur(rec.duration_sec)

    # ── YAML frontmatter ────────────────────────────────────────────────────
    lines = [
        "---",
        f'title: "{rec.title}"',
        f"date: {date_iso}",
        f"duration: {duration}",
    ]
    if speakers:
        lines.append("participants: [" + ", ".join(f'"{s}"' for s in speakers) + "]")
    lines += [
        "tags:",
        "  - tarscribe",
        "---",
        "",
        f"# {rec.title}",
        "",
    ]

    # ── Zusammenfassung als Callout ─────────────────────────────────────────
    if summary and summary.content.strip():
        lines += ["## Zusammenfassung", ""]
        for summary_line in summary.content.strip().splitlines():
            lines.append(summary_line)
        lines.append("")

    # ── Transkript ──────────────────────────────────────────────────────────
    lines += ["## Transkript", ""]
    if diarized:
        for u in utterances:
            speaker_name = name_map.get(u.speaker, u.speaker)
            ts = _fmt_ts(u.start)
            lines.append(f"**{speaker_name}** `[{ts}]`: {u.text}")
            lines.append("")
    else:
        lines.append("".join(w.text for w in words).strip())

    return "\n".join(lines)


@router.post("/{recording_id}/send-to-folder")
def send_to_folder(recording_id: int, session: Session = Depends(get_session)) -> dict:
    """Write a Markdown note into the topic's configured export folder (e.g. Obsidian)."""
    rec, words, segments, name_map = _load(session, recording_id)
    if not words:
        raise HTTPException(404, "Noch kein Transkript vorhanden")

    topic = session.get(Topic, rec.topic_id)
    if not topic or not topic.export_path:
        raise HTTPException(
            400, "Für diesen Themenbereich ist kein Export-Ordner gesetzt."
        )
    folder = Path(topic.export_path).expanduser()
    if not folder.is_absolute():
        raise HTTPException(400, "Export-Ordner muss ein absoluter Pfad sein.")
    if not folder.is_dir():
        raise HTTPException(400, f"Ordner existiert nicht: {folder}")
    folder = folder.resolve()

    content = _build_markdown(session, rec, words, segments, name_map)
    try:
        target = require_child_path(folder / f"{_safe_filename(rec.title)}.md", folder)
    except UploadPathForbidden as exc:
        raise HTTPException(400, "Export-Ziel liegt außerhalb des Export-Ordners") from exc
    try:
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(500, f"Schreiben fehlgeschlagen: {exc}") from exc
    _mark_exported(session, rec)
    return {"path": str(target)}

"""Endpoints to trigger ASR and fetch transcripts / job status."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import (
    enqueue_action_items,
    enqueue_asr,
    enqueue_chapters,
    enqueue_diarization,
    enqueue_embedding,
    enqueue_summary,
    serialize_job,
)
from ..models import (
    DiarizationRun,
    Job,
    JobPhase,
    JobStatus,
    Recording,
    Summary,
    TranscriptCorrection,
)
from ..pagination import CursorError, decode_cursor, encode_cursor
from ..transcript_quality import analyze_words, filter_acknowledged_issues, quality_summary
from ..transcript_view import effective_text, load_effective_words

router = APIRouter(prefix="/api/recordings", tags=["transcription"])


@router.post("/{recording_id}/transcribe")
def transcribe(
    recording_id: int, asr: str | None = None, session: Session = Depends(get_session)
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    job_id = enqueue_asr(recording_id, override=asr)
    return {"job_id": job_id, "status": "queued"}


@router.get("/{recording_id}/transcript")
def get_transcript(recording_id: int, session: Session = Depends(get_session)) -> dict:
    loaded = load_effective_words(session, recording_id)
    if not loaded:
        raise HTTPException(404, "Noch kein Transkript vorhanden")
    snapshot, words = loaded
    transcript = snapshot.transcript
    issues = analyze_words(words, transcript_id=transcript.id or 0, revision=transcript.revision)
    acknowledgements = session.exec(
        select(TranscriptCorrection).where(
            TranscriptCorrection.recording_id == recording_id,
            TranscriptCorrection.source_transcript_id == transcript.id,
            TranscriptCorrection.status == "ignored",
        )
    ).all()
    issues = filter_acknowledged_issues(
        issues,
        acknowledgements,
        transcript_id=transcript.id or 0,
    )
    return {
        "transcript_id": transcript.id,
        "asr_model": transcript.asr_model,
        "language": transcript.language,
        "revision": transcript.revision,
        "text": effective_text(words),
        "raw_text": "".join(w.text for w in snapshot.words).strip(),
        "quality": quality_summary(words, issues),
        "words": [
            {
                "start": w.start,
                "end": w.end,
                "text": w.text,
                "raw_text": w.raw_text,
                "confidence": w.confidence,
                "source_start_idx": w.source_start_idx,
                "source_end_idx": w.source_end_idx,
                "correction_id": w.correction_id,
            }
            for w in words
        ],
    }


@router.get("/{recording_id}/transcript/context")
def get_transcript_context(
    recording_id: int,
    start_sec: float | None = Query(default=None, ge=0),
    end_sec: float | None = Query(default=None, gt=0),
    cursor: str | None = None,
    limit: int = Query(default=500, ge=1, le=2000),
    include_words: bool = False,
    session: Session = Depends(get_session),
) -> dict:
    if end_sec is not None and start_sec is not None and end_sec <= start_sec:
        raise HTTPException(422, "end_sec muss nach start_sec liegen")
    try:
        offset = decode_cursor(cursor, f"transcript:{recording_id}", default=0) or 0
    except CursorError as exc:
        raise HTTPException(400, str(exc)) from exc
    loaded = load_effective_words(session, recording_id)
    if not loaded:
        raise HTTPException(404, "Noch kein Transkript vorhanden")
    snapshot, words = loaded
    selected = [
        word
        for word in words
        if (start_sec is None or word.end >= start_sec) and (end_sec is None or word.start < end_sec)
    ]
    page = selected[offset : offset + limit]
    next_offset = offset + limit
    has_more = next_offset < len(selected)
    transcript = snapshot.transcript
    payload = {
        "transcript_id": transcript.id,
        "asr_model": transcript.asr_model,
        "language": transcript.language,
        "revision": transcript.revision,
        "text": effective_text(page),
        "start_sec": page[0].start if page else start_sec,
        "end_sec": page[-1].end if page else end_sec,
        "total_word_count": len(selected),
        "returned_word_count": len(page),
        "has_more": has_more,
        "next_cursor": (
            encode_cursor(f"transcript:{recording_id}", next_offset) if has_more else None
        ),
    }
    if include_words:
        payload["words"] = [
            {
                "start": word.start,
                "end": word.end,
                "text": word.text,
                "confidence": word.confidence,
                "corrected": word.correction_id is not None,
            }
            for word in page
        ]
    return payload


def _reenqueue_for_phase(session: Session, recording_id: int, phase: JobPhase) -> int:
    """Start a fresh job for the same work a failed job was doing."""
    if phase == JobPhase.asr:
        return enqueue_asr(recording_id)
    if phase == JobPhase.diarization:
        # Reuse the most recent run's tuning parameters when available.
        run = session.exec(
            select(DiarizationRun)
            .where(DiarizationRun.recording_id == recording_id)
            .order_by(DiarizationRun.created_at.desc())
        ).first()
        params = json.loads(run.params_json or "{}") if run else {}
        return enqueue_diarization(recording_id, params)
    if phase == JobPhase.action_items:
        return enqueue_action_items(recording_id)
    if phase == JobPhase.chapters:
        return enqueue_chapters(recording_id)
    if phase == JobPhase.embedding:
        job_id = enqueue_embedding(recording_id)
        if job_id is None:
            raise HTTPException(409, "Einbettung ist nicht verfügbar (RAG deaktiviert).")
        return job_id
    if phase == JobPhase.summarize:
        # The failed summary already created an (empty) Summary row; reuse it.
        summary = session.exec(
            select(Summary)
            .where(Summary.recording_id == recording_id, Summary.content == "")
            .order_by(Summary.created_at.desc())
        ).first()
        if not summary or summary.template_id is None:
            raise HTTPException(
                409, "Zusammenfassung kann nicht wiederholt werden — bitte neu starten."
            )
        return enqueue_summary(recording_id, summary.template_id, summary.id)
    raise HTTPException(400, f"Phase {phase.value} kann nicht wiederholt werden.")


@router.post("/{recording_id}/jobs/{job_id}/retry")
def retry_job(
    recording_id: int, job_id: int, session: Session = Depends(get_session)
) -> dict:
    job = session.get(Job, job_id)
    if not job or job.recording_id != recording_id:
        raise HTTPException(404, "Auftrag nicht gefunden")
    if job.status != JobStatus.failed:
        raise HTTPException(409, "Nur fehlgeschlagene Aufträge können wiederholt werden")
    new_job_id = _reenqueue_for_phase(session, recording_id, job.phase)
    return {"job_id": new_job_id, "phase": job.phase.value, "status": "queued"}


@router.get("/{recording_id}/jobs")
def list_jobs(recording_id: int, session: Session = Depends(get_session)) -> list[dict]:
    jobs = session.exec(
        select(Job)
        .where(Job.recording_id == recording_id)
        .order_by(Job.created_at.desc())
    ).all()
    return [serialize_job(job) for job in jobs]

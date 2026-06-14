"""Endpoints to trigger ASR and fetch transcripts / job status."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
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
    Transcript,
    Word,
)
from ..security import require_token

router = APIRouter(prefix="/api/recordings", tags=["transcription"])


@router.post("/{recording_id}/transcribe", dependencies=[Depends(require_token)])
def transcribe(
    recording_id: int, asr: str | None = None, session: Session = Depends(get_session)
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    job_id = enqueue_asr(recording_id, override=asr)
    return {"job_id": job_id, "status": "queued"}


@router.get("/{recording_id}/transcript", dependencies=[Depends(require_token)])
def get_transcript(recording_id: int, session: Session = Depends(get_session)) -> dict:
    transcript = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).first()
    if not transcript:
        raise HTTPException(404, "Noch kein Transkript vorhanden")
    words = session.exec(
        select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
    ).all()
    return {
        "transcript_id": transcript.id,
        "asr_model": transcript.asr_model,
        "language": transcript.language,
        "text": "".join(w.text for w in words).strip(),
        "words": [
            {"start": w.start, "end": w.end, "text": w.text, "confidence": w.confidence}
            for w in words
        ],
    }


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


@router.post("/{recording_id}/jobs/{job_id}/retry", dependencies=[Depends(require_token)])
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


@router.get("/{recording_id}/jobs", dependencies=[Depends(require_token)])
def list_jobs(recording_id: int, session: Session = Depends(get_session)) -> list[dict]:
    jobs = session.exec(
        select(Job)
        .where(Job.recording_id == recording_id)
        .order_by(Job.created_at.desc())
    ).all()
    return [serialize_job(job) for job in jobs]

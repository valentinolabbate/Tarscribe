"""Endpoints to trigger ASR and fetch transcripts / job status."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import enqueue_asr
from ..models import Job, Recording, Transcript, Word
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


@router.get("/{recording_id}/jobs", dependencies=[Depends(require_token)])
def list_jobs(recording_id: int, session: Session = Depends(get_session)) -> list[Job]:
    return list(
        session.exec(
            select(Job)
            .where(Job.recording_id == recording_id)
            .order_by(Job.created_at.desc())
        ).all()
    )

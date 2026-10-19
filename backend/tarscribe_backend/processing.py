from fastapi import HTTPException
from sqlmodel import Session, select

from .models import DiarizationRun, Job, JobStatus, Recording, Transcript, Word


def require_processing_ready(
    session: Session,
    recording_id: int,
    *,
    transcript: bool = True,
    speakers: bool = False,
) -> Recording:
    recording = session.get(Recording, recording_id)
    if not recording:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    if session.exec(select(Job.id).where(
        Job.recording_id == recording_id,
        Job.status.in_([JobStatus.pending, JobStatus.running]),
    )).first() is not None:
        raise HTTPException(409, "Bitte zuerst die laufende Verarbeitung abschließen.")
    if transcript and session.exec(
        select(Word.id).join(Transcript).where(Transcript.recording_id == recording_id).limit(1)
    ).first() is None:
        raise HTTPException(409, "Bitte zuerst die Transkription starten und abschließen.")
    if speakers and session.exec(select(DiarizationRun.id).where(
        DiarizationRun.recording_id == recording_id,
        DiarizationRun.is_active.is_(True),
    )).first() is None:
        raise HTTPException(409, "Bitte zuerst die optionale Diarisierung durchführen.")
    return recording

"""Recording upload, listing, and audio streaming."""

from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..audio import AudioError, normalize_to_wav, probe_duration
from ..config import get_settings
from ..db import get_session
from ..models import Recording, RecordingStatus, Topic
from ..schemas import RecordingUpdate
from ..security import require_token

router = APIRouter(
    prefix="/api/recordings", tags=["recordings"], dependencies=[Depends(require_token)]
)


@router.get("")
def list_recordings(
    topic_id: int | None = None, session: Session = Depends(get_session)
) -> list[Recording]:
    stmt = select(Recording).order_by(Recording.created_at.desc())
    if topic_id is not None:
        stmt = stmt.where(Recording.topic_id == topic_id)
    return list(session.exec(stmt).all())


@router.get("/{recording_id}")
def get_recording(recording_id: int, session: Session = Depends(get_session)) -> Recording:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    return rec


@router.post("", status_code=201)
async def upload_recording(
    topic_id: int = Form(...),
    title: str | None = Form(None),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> Recording:
    if not session.get(Topic, topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")

    settings = get_settings()
    rec_id = uuid.uuid4().hex
    dst = settings.audio_dir / f"{rec_id}.wav"

    # Persist the upload to a temp file, then normalize into the audio dir.
    suffix = Path(file.filename or "audio").suffix or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    try:
        normalize_to_wav(tmp_path, dst)
    except AudioError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    duration = probe_duration(dst)
    display_title = (title or "").strip() or Path(file.filename or "Aufnahme").stem

    rec = Recording(
        topic_id=topic_id,
        title=display_title,
        audio_path=str(dst),
        original_filename=file.filename,
        duration_sec=duration,
        status=RecordingStatus.uploaded,
    )
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


@router.patch("/{recording_id}")
def update_recording(
    recording_id: int, payload: RecordingUpdate, session: Session = Depends(get_session)
) -> Recording:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    if payload.title is not None:
        rec.title = payload.title
    if payload.topic_id is not None:
        rec.topic_id = payload.topic_id
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


@router.delete("/{recording_id}", status_code=204)
def delete_recording(recording_id: int, session: Session = Depends(get_session)) -> None:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    Path(rec.audio_path).unlink(missing_ok=True)
    session.delete(rec)
    session.commit()


@router.get("/{recording_id}/audio")
def stream_audio(recording_id: int, session: Session = Depends(get_session)) -> FileResponse:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    path = Path(rec.audio_path)
    if not path.exists():
        raise HTTPException(410, "Audiodatei nicht mehr vorhanden")
    return FileResponse(path, media_type="audio/wav", filename=path.name)

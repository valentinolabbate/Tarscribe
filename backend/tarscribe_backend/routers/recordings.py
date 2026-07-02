"""Recording upload, listing, and audio streaming."""

from __future__ import annotations

import json
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..audio import AudioError, compute_waveform_peaks, mix_to_wav, normalize_to_wav, probe_duration
from ..config import get_settings
from ..db import get_session
from ..models import (
    Document,
    Job,
    JobStatus,
    Recording,
    RecordingStatus,
    Topic,
)
from ..schemas import RecordingUpdate
from ..upload_security import (
    AUDIO_UPLOAD_SUFFIXES,
    LOCAL_AUDIO_SUFFIXES,
    UploadPathForbidden,
    UploadValidationError,
    display_filename,
    require_suffix,
    resolve_allowed_file,
)

router = APIRouter(prefix="/api/recordings", tags=["recordings"])


class LocalRecordingImport(BaseModel):
    topic_id: int
    title: str | None = None
    path: str


def _persist_recording(
    source: Path,
    topic_id: int,
    title: str | None,
    original_filename: str,
    session: Session,
    microphone_source: Path | None = None,
    kind: str = "recording",
) -> Recording:
    settings = get_settings()
    rec_id = uuid.uuid4().hex
    dst = settings.audio_dir / f"{rec_id}.wav"
    try:
        if microphone_source is None:
            normalize_to_wav(source, dst)
        else:
            mix_to_wav(source, microphone_source, dst)
    except AudioError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        source.unlink(missing_ok=True)
        if microphone_source is not None:
            microphone_source.unlink(missing_ok=True)

    duration = probe_duration(dst)
    display_title = (title or "").strip() or Path(original_filename).stem
    rec = Recording(
        topic_id=topic_id,
        title=display_title,
        audio_path=str(dst),
        original_filename=original_filename,
        duration_sec=duration,
        kind=kind,
        status=RecordingStatus.uploaded,
    )
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


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

    original_filename = display_filename(file.filename, "Aufnahme.wav")
    try:
        suffix = require_suffix(original_filename, AUDIO_UPLOAD_SUFFIXES, "Audio")
    except UploadValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    return _persist_recording(
        tmp_path,
        topic_id,
        title,
        original_filename,
        session,
    )


@router.post("/import-local", status_code=201)
def import_local_recording(
    payload: LocalRecordingImport,
    session: Session = Depends(get_session),
) -> Recording:
    if not session.get(Topic, payload.topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")

    settings = get_settings()
    try:
        source = resolve_allowed_file(payload.path, [settings.native_recordings_dir])
        require_suffix(source.name, LOCAL_AUDIO_SUFFIXES, "Audio")
    except UploadValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    except UploadPathForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "Lokale Aufnahmedatei nicht gefunden") from exc
    return _persist_recording(source, payload.topic_id, payload.title, source.name, session)


@router.post("/import-local-mixed", status_code=201)
async def import_local_mixed_recording(
    topic_id: int = Form(...),
    path: str = Form(...),
    title: str | None = Form(None),
    microphone: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> Recording:
    if not session.get(Topic, topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")

    settings = get_settings()
    try:
        source = resolve_allowed_file(path, [settings.native_recordings_dir])
        require_suffix(source.name, LOCAL_AUDIO_SUFFIXES, "Audio")
    except UploadValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    except UploadPathForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "Lokale Aufnahmedatei nicht gefunden") from exc

    microphone_filename = display_filename(microphone.filename, "microphone.webm")
    try:
        suffix = require_suffix(microphone_filename, AUDIO_UPLOAD_SUFFIXES, "Audio")
    except UploadValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(microphone.file, tmp)
        microphone_path = Path(tmp.name)
    return _persist_recording(
        source,
        topic_id,
        title,
        f"{source.stem}-mixed.caf",
        session,
        microphone_source=microphone_path,
    )


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
        if not session.get(Topic, payload.topic_id):
            raise HTTPException(404, "Themenbereich nicht gefunden")
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

    jobs = session.exec(select(Job).where(Job.recording_id == recording_id)).all()
    if any(job.status in (JobStatus.pending, JobStatus.running) for job in jobs):
        raise HTTPException(409, "Aufnahme wird noch verarbeitet und kann nicht gelöscht werden.")

    audio_path = Path(rec.audio_path)
    from ..db import vec_available

    if vec_available():
        from .. import rag

        rag._delete_recording_chunks(session, recording_id)

    from .documents import _stored_paths_for_delete

    doc_files: list[Path] = []
    for doc in session.exec(
        select(Document).where(Document.recording_id == recording_id)
    ).all():
        doc_files.extend(_stored_paths_for_delete(doc))

    session.delete(rec)
    session.commit()
    try:
        audio_path.unlink(missing_ok=True)
    except OSError as exc:
        print(f"Audiodatei konnte nach DB-Löschung nicht entfernt werden: {exc}")
    for waveform_path in get_settings().waveforms_dir.glob(f"{recording_id}-*.json"):
        waveform_path.unlink(missing_ok=True)
    for doc_file in doc_files:
        try:
            doc_file.unlink(missing_ok=True)
        except OSError as exc:
            print(f"Dokumentdatei konnte nach DB-Löschung nicht entfernt werden: {exc}")


@router.get("/{recording_id}/audio")
def stream_audio(recording_id: int, session: Session = Depends(get_session)) -> FileResponse:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    path = Path(rec.audio_path)
    if not path.exists():
        raise HTTPException(410, "Audiodatei nicht mehr vorhanden")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@router.get("/{recording_id}/waveform")
def get_waveform(
    recording_id: int,
    points: int = Query(2400, ge=200, le=5000),
    session: Session = Depends(get_session),
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    path = Path(rec.audio_path)
    if not path.exists():
        raise HTTPException(410, "Audiodatei nicht mehr vorhanden")

    stat = path.stat()
    settings = get_settings()
    cache_path = settings.waveforms_dir / (
        f"{recording_id}-{stat.st_size}-{stat.st_mtime_ns}-{points}.json"
    )
    try:
        return json.loads(cache_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass

    try:
        duration, peaks = compute_waveform_peaks(path, points)
    except AudioError as exc:
        raise HTTPException(422, str(exc)) from exc
    payload = {"duration_sec": duration or rec.duration_sec, "peaks": peaks}
    try:
        for stale_path in settings.waveforms_dir.glob(f"{recording_id}-*.json"):
            stale_path.unlink(missing_ok=True)
        cache_path.write_text(json.dumps(payload, separators=(",", ":")))
    except OSError:
        pass
    return payload

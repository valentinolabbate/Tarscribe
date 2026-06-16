"""Recording upload, listing, and audio streaming."""

from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..audio import AudioError, mix_to_wav, normalize_to_wav, probe_duration
from ..config import get_settings
from ..db import get_session
from ..models import (
    DiarizationRun,
    Job,
    JobStatus,
    LiveRecordingSession,
    ManualEdit,
    Recording,
    RecordingStatus,
    Segment,
    SpeakerLabel,
    Summary,
    Topic,
    Transcript,
    Word,
)
from ..schemas import RecordingUpdate
from ..security import require_token

router = APIRouter(
    prefix="/api/recordings", tags=["recordings"], dependencies=[Depends(require_token)]
)


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

    # Persist the upload to a temp file, then normalize into the audio dir.
    suffix = Path(file.filename or "audio").suffix or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    return _persist_recording(
        tmp_path,
        topic_id,
        title,
        file.filename or "Aufnahme",
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
    source = Path(payload.path).resolve()
    try:
        source.relative_to(settings.native_recordings_dir.resolve())
    except ValueError as exc:
        raise HTTPException(403, "Lokale Aufnahmedatei liegt außerhalb des erlaubten Ordners") from exc
    if not source.is_file():
        raise HTTPException(404, "Lokale Aufnahmedatei nicht gefunden")
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
    source = Path(path).resolve()
    try:
        source.relative_to(settings.native_recordings_dir.resolve())
    except ValueError as exc:
        raise HTTPException(403, "Lokale Aufnahmedatei liegt außerhalb des erlaubten Ordners") from exc
    if not source.is_file():
        raise HTTPException(404, "Lokale Aufnahmedatei nicht gefunden")

    suffix = Path(microphone.filename or "microphone").suffix or ".bin"
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
    transcripts = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).all()
    for transcript in transcripts:
        for word in session.exec(select(Word).where(Word.transcript_id == transcript.id)).all():
            session.delete(word)
    session.flush()
    for transcript in transcripts:
        session.delete(transcript)
    session.flush()

    runs = session.exec(
        select(DiarizationRun).where(DiarizationRun.recording_id == recording_id)
    ).all()
    for run in runs:
        for segment in session.exec(select(Segment).where(Segment.run_id == run.id)).all():
            session.delete(segment)
    session.flush()
    for run in runs:
        session.delete(run)
    session.flush()

    # RAG chunks reference both summaries and the recording (FKs) — clear them
    # (incl. the sqlite-vec rows) before deleting those rows.
    from ..db import vec_available

    if vec_available():
        from .. import rag

        rag._delete_recording_chunks(session, recording_id)

    from ..models import ActionItem, Chapter, Document

    for model in (SpeakerLabel, ManualEdit, Summary, ActionItem, Chapter):
        for row in session.exec(select(model).where(model.recording_id == recording_id)).all():
            session.delete(row)

    # Documents attached to this recording: their RAG chunks were removed above
    # with the recording's chunks; now drop the rows and (after commit) the files.
    doc_files: list[Path] = []
    for doc in session.exec(
        select(Document).where(Document.recording_id == recording_id)
    ).all():
        doc_files.append(Path(doc.file_path))
        session.delete(doc)

    for job in jobs:
        session.delete(job)

    # Remove any live session that references this recording; without this the
    # LiveRecordingSession.finalized_recording_id FK (NO ACTION) would block the delete.
    for live in session.exec(
        select(LiveRecordingSession).where(
            LiveRecordingSession.finalized_recording_id == recording_id
        )
    ).all():
        session.delete(live)

    session.flush()
    session.delete(rec)
    session.commit()
    try:
        audio_path.unlink(missing_ok=True)
    except OSError as exc:
        print(f"Audiodatei konnte nach DB-Löschung nicht entfernt werden: {exc}")
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

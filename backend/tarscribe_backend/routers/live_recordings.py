"""Live recording session lifecycle and PCM chunk upload."""

from __future__ import annotations

import json
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from .. import jobs
from ..live_analysis import get_service
from ..live_audio import cleanup_session_dir, validate_and_append_chunk
from ..models import (
    LiveRecordingSession,
    LiveSessionStatus,
    Recording,
    RecordingStatus,
    Transcript,
    Topic,
    Word,
)
from ..schemas import LiveSessionCreate, LiveSessionFinish
from ..security import require_token
from ..ws import hub

router = APIRouter(
    prefix="/api/live-recordings",
    tags=["live-recordings"],
    dependencies=[Depends(require_token)],
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_dict(sess: LiveRecordingSession) -> dict[str, Any]:
    return {
        "id": sess.id,
        "topic_id": sess.topic_id,
        "title": sess.title,
        "status": sess.status.value if hasattr(sess.status, "value") else sess.status,
        "sample_rate": sess.sample_rate,
        "channels": sess.channels,
        "last_sequence_number": sess.last_sequence_number,
        "received_duration_sec": sess.received_duration_sec,
        "transcript_snapshot_json": sess.transcript_snapshot_json,
        "speaker_snapshot_json": sess.speaker_snapshot_json,
        "last_analyzed_sec": sess.last_analyzed_sec,
        "finalized_recording_id": sess.finalized_recording_id,
        "error": sess.error,
        "created_at": sess.created_at.isoformat(),
        "updated_at": sess.updated_at.isoformat(),
    }


def _normalise_live_words(snapshot_json: str | None) -> list[dict[str, Any]]:
    if not snapshot_json:
        return []
    try:
        snapshot = json.loads(snapshot_json)
    except (TypeError, json.JSONDecodeError):
        return []

    raw_words = snapshot.get("words")
    if not isinstance(raw_words, list):
        return []

    words: list[dict[str, Any]] = []
    for raw in raw_words:
        if not isinstance(raw, dict):
            continue
        text_value = raw.get("text")
        if text_value is None:
            continue
        text = str(text_value)
        if not text.strip():
            continue
        try:
            start = float(raw.get("start", 0.0))
        except (TypeError, ValueError):
            start = 0.0
        try:
            end = float(raw.get("end", start))
        except (TypeError, ValueError):
            end = start
        if end < start:
            end = start

        confidence_value = raw.get("confidence")
        try:
            confidence = float(confidence_value) if confidence_value is not None else None
        except (TypeError, ValueError):
            confidence = None

        words.append({"start": start, "end": end, "text": text, "confidence": confidence})
    return words


def _recording_has_persisted_words(session: Session, recording_id: int) -> bool:
    transcripts = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).all()
    for transcript in transcripts:
        if transcript.id is None:
            continue
        first_word = session.exec(
            select(Word.id).where(Word.transcript_id == transcript.id).limit(1)
        ).first()
        if first_word is not None:
            return True
    return False


def _persist_live_transcript_snapshot(
    session: Session,
    live_session: LiveRecordingSession,
    recording: Recording,
) -> bool:
    if recording.id is None:
        return False

    if _recording_has_persisted_words(session, recording.id):
        if recording.status == RecordingStatus.uploaded:
            recording.status = RecordingStatus.ready
            session.add(recording)
        return False

    words = _normalise_live_words(live_session.transcript_snapshot_json)
    if not words:
        return False

    old_transcripts = session.exec(
        select(Transcript).where(Transcript.recording_id == recording.id)
    ).all()
    for transcript in old_transcripts:
        if transcript.id is None:
            continue
        for word in session.exec(select(Word).where(Word.transcript_id == transcript.id)).all():
            session.delete(word)
    session.flush()
    for transcript in old_transcripts:
        session.delete(transcript)
    session.flush()

    transcript = Transcript(
        recording_id=recording.id,
        asr_model="live",
        language=recording.language,
    )
    session.add(transcript)
    session.flush()

    for idx, word in enumerate(words):
        session.add(
            Word(
                transcript_id=transcript.id,
                idx=idx,
                start=word["start"],
                end=word["end"],
                text=word["text"],
                confidence=word["confidence"],
            )
        )

    recording.status = RecordingStatus.ready
    session.add(recording)
    return True


@router.post("", status_code=201)
def create_session(
    payload: LiveSessionCreate,
    session: Session = Depends(get_session),
) -> dict:
    if not session.get(Topic, payload.topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")

    settings = get_settings()
    session_id = uuid.uuid4().hex
    pcm_dir = settings.live_pcm_dir / session_id
    pcm_dir.mkdir(parents=True, exist_ok=True)
    pcm_path = pcm_dir / "audio.pcm"

    live_session = LiveRecordingSession(
        id=session_id,
        topic_id=payload.topic_id,
        title=payload.title,
        status=LiveSessionStatus.recording,
        pcm_path=str(pcm_path),
    )
    session.add(live_session)
    session.commit()
    session.refresh(live_session)

    get_service().attach(session_id)
    hub.broadcast({"type": "live_session", "session_id": session_id, "status": "recording"})
    return _to_dict(live_session)


@router.get("/{session_id}")
def get_session_detail(
    session_id: str,
    session: Session = Depends(get_session),
) -> dict:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")
    return _to_dict(live_session)


@router.post("/{session_id}/chunks")
async def upload_chunk(
    session_id: str,
    request: Request,
    x_sequence_number: int = Header(...),
    x_sample_rate: int = Header(default=16000),
    x_channels: int = Header(default=1),
    session: Session = Depends(get_session),
) -> dict:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")

    if live_session.status not in (LiveSessionStatus.recording, LiveSessionStatus.paused):
        raise HTTPException(409, f"Session ist nicht aktiv: {live_session.status}")

    if x_sample_rate != live_session.sample_rate or x_channels != live_session.channels:
        raise HTTPException(
            422,
            f"Audioformat passt nicht zur Session: erwartet "
            f"{live_session.sample_rate} Hz/{live_session.channels} Kanal/Kanäle, "
            f"erhalten {x_sample_rate} Hz/{x_channels}",
        )

    chunk_data = await request.body()
    pcm_path = Path(live_session.pcm_path)
    expected_next = live_session.last_sequence_number + 1

    result = validate_and_append_chunk(
        pcm_path=pcm_path,
        chunk_data=chunk_data,
        sequence_number=x_sequence_number,
        expected_next_sequence=expected_next,
        sample_rate=live_session.sample_rate,
        channels=live_session.channels,
    )

    if not result.accepted and result.reason != "already_processed":
        raise HTTPException(422, f"Chunk abgelehnt: {result.reason}")

    if result.last_sequence_number > live_session.last_sequence_number:
        live_session.last_sequence_number = result.last_sequence_number
        live_session.received_duration_sec = result.received_duration_sec
        live_session.updated_at = _utcnow()
        session.add(live_session)
        session.commit()

        hub.broadcast({
            "type": "live_session",
            "session_id": session_id,
            "status": live_session.status.value,
            "received_duration_sec": result.received_duration_sec,
        })

        # Signal the analysis service; it decides whether to run based on its own timer.
        get_service().tick(session_id)

    return {
        "accepted": result.accepted,
        "last_sequence_number": result.last_sequence_number,
        "received_duration_sec": result.received_duration_sec,
    }


@router.post("/{session_id}/pause")
def pause_session(
    session_id: str,
    session: Session = Depends(get_session),
) -> dict:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")
    if live_session.status != LiveSessionStatus.recording:
        raise HTTPException(409, "Session ist nicht im Aufnahme-Zustand")
    live_session.status = LiveSessionStatus.paused
    live_session.updated_at = _utcnow()
    session.add(live_session)
    session.commit()
    hub.broadcast({"type": "live_session", "session_id": session_id, "status": "paused"})
    return {"status": "paused"}


@router.post("/{session_id}/resume")
def resume_session(
    session_id: str,
    session: Session = Depends(get_session),
) -> dict:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")
    if live_session.status != LiveSessionStatus.paused:
        raise HTTPException(409, "Session ist nicht pausiert")
    live_session.status = LiveSessionStatus.recording
    live_session.updated_at = _utcnow()
    session.add(live_session)
    session.commit()
    hub.broadcast({"type": "live_session", "session_id": session_id, "status": "recording"})
    return {"status": "recording"}


@router.post("/{session_id}/finish")
def finish_session(
    session_id: str,
    payload: LiveSessionFinish,
    session: Session = Depends(get_session),
) -> dict:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")
    if live_session.status not in (LiveSessionStatus.recording, LiveSessionStatus.paused):
        raise HTTPException(409, f"Session kann nicht finalisiert werden: {live_session.status}")
    recording: Recording | None = None
    if payload.recording_id is not None:
        recording = session.get(Recording, payload.recording_id)
        if not recording:
            raise HTTPException(404, "Aufnahme nicht gefunden")
        _persist_live_transcript_snapshot(session, live_session, recording)

    live_session.status = LiveSessionStatus.completed
    live_session.finalized_recording_id = payload.recording_id
    live_session.updated_at = _utcnow()
    session.add(live_session)
    session.commit()

    pcm_path = live_session.pcm_path
    get_service().detach(session_id)

    transcription_job_id: int | None = None
    if recording is not None and recording.id is not None:
        try:
            transcription_job_id = jobs.enqueue_asr(recording.id)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    hub.broadcast({
        "type": "live_finalized",
        "session_id": session_id,
        "recording_id": payload.recording_id,
        "transcription_job_id": transcription_job_id,
    })
    threading.Thread(target=cleanup_session_dir, args=(pcm_path,), daemon=True).start()

    return {
        "status": "completed",
        "recording_id": payload.recording_id,
        "transcription_job_id": transcription_job_id,
    }


@router.delete("/{session_id}", status_code=204)
def cancel_session(
    session_id: str,
    session: Session = Depends(get_session),
) -> None:
    live_session = session.get(LiveRecordingSession, session_id)
    if not live_session:
        raise HTTPException(404, "Session nicht gefunden")
    pcm_path = live_session.pcm_path
    live_session.status = LiveSessionStatus.canceled
    live_session.updated_at = _utcnow()
    session.add(live_session)
    session.commit()
    get_service().detach(session_id)
    hub.broadcast({"type": "live_session", "session_id": session_id, "status": "canceled"})
    threading.Thread(target=cleanup_session_dir, args=(pcm_path,), daemon=True).start()

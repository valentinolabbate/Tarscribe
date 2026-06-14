"""Quick dictation inbox upload and transcription trigger."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import enqueue_asr
from ..models import Topic
from ..security import require_token
from .recordings import _persist_recording

router = APIRouter(prefix="/api/dictations", tags=["dictations"], dependencies=[Depends(require_token)])

INBOX_TOPIC_NAME = "Inbox"


def _get_or_create_inbox_topic(session: Session) -> Topic:
    topic = session.exec(select(Topic).where(Topic.name == INBOX_TOPIC_NAME)).first()
    if topic:
        return topic
    topic = Topic(name=INBOX_TOPIC_NAME, color="#0f766e")
    session.add(topic)
    session.flush()
    return topic


@router.post("", status_code=201)
async def create_dictation(
    title: str | None = Form(None),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    topic = _get_or_create_inbox_topic(session)
    suffix = Path(file.filename or "dictation").suffix or ".bin"
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = Path(tmp.name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Diktat konnte nicht gelesen werden: {exc}") from exc

    recording = _persist_recording(
        tmp_path,
        topic.id,
        title,
        file.filename or "Diktat",
        session,
        kind="dictation",
    )
    job_id = enqueue_asr(recording.id)
    return {
        "recording": recording,
        "job_id": job_id,
        "topic_id": topic.id,
        "topic_name": topic.name,
    }

"""Stage D manual corrections: rename / merge / reassign speakers + reset."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import jobs
from ..db import get_session
from ..models import ManualEdit, Recording, SpeakerLabel
from ..security import require_token

router = APIRouter(prefix="/api/recordings", tags=["editing"], dependencies=[Depends(require_token)])


class RenameIn(BaseModel):
    label: str
    name: str


class MergeIn(BaseModel):
    from_label: str
    to_label: str


class ReassignIn(BaseModel):
    start: float
    end: float
    speaker: str


def _require_recording(session: Session, recording_id: int) -> Recording:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    return rec


@router.post("/{recording_id}/speakers/rename")
def rename_speaker(
    recording_id: int, payload: RenameIn, session: Session = Depends(get_session)
) -> dict:
    _require_recording(session, recording_id)
    label = session.exec(
        select(SpeakerLabel).where(
            SpeakerLabel.recording_id == recording_id,
            SpeakerLabel.original_label == payload.label,
        )
    ).first()
    if label is None:
        label = SpeakerLabel(recording_id=recording_id, original_label=payload.label)
    label.display_name = payload.name.strip() or None
    session.add(label)
    session.commit()
    jobs.schedule_reindex(recording_id)
    return {"ok": True}


@router.post("/{recording_id}/speakers/merge")
def merge_speakers(
    recording_id: int, payload: MergeIn, session: Session = Depends(get_session)
) -> dict:
    _require_recording(session, recording_id)
    if payload.from_label == payload.to_label:
        raise HTTPException(400, "Quelle und Ziel sind identisch")
    session.add(
        ManualEdit(
            recording_id=recording_id,
            edit_type="merge",
            payload_json=json.dumps({"from": payload.from_label, "to": payload.to_label}),
        )
    )
    session.commit()
    jobs.schedule_reindex(recording_id)
    return {"ok": True}


@router.post("/{recording_id}/segments/reassign")
def reassign_segment(
    recording_id: int, payload: ReassignIn, session: Session = Depends(get_session)
) -> dict:
    _require_recording(session, recording_id)
    session.add(
        ManualEdit(
            recording_id=recording_id,
            edit_type="reassign",
            payload_json=json.dumps(
                {"start": payload.start, "end": payload.end, "speaker": payload.speaker}
            ),
        )
    )
    session.commit()
    jobs.schedule_reindex(recording_id)
    return {"ok": True}


@router.post("/{recording_id}/edits/reset")
def reset_overlay(recording_id: int, session: Session = Depends(get_session)) -> dict:
    _require_recording(session, recording_id)
    for e in session.exec(
        select(ManualEdit).where(ManualEdit.recording_id == recording_id)
    ).all():
        session.delete(e)
    for lab in session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all():
        session.delete(lab)
    session.commit()
    jobs.schedule_reindex(recording_id)
    return {"ok": True}

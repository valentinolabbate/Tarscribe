"""Trigger diarization and fetch the speaker-aligned transcript."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import enqueue_diarization
from ..ml.alignment import build_utterances
from ..ml.diarization import SpeakerSegment
from ..overlay import load_overlay
from ..models import (
    DiarizationRun,
    Recording,
    Segment,
    SpeakerLabel,
    Transcript,
    Word,
)

router = APIRouter(prefix="/api/recordings", tags=["diarization"])


class DiarizeParamsIn(BaseModel):
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None
    clustering_threshold: float | None = None
    min_duration_off: float | None = None


@router.post("/{recording_id}/diarize")
def diarize(
    recording_id: int,
    params: DiarizeParamsIn | None = None,
    session: Session = Depends(get_session),
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    job_id = enqueue_diarization(recording_id, (params or DiarizeParamsIn()).model_dump())
    return {"job_id": job_id, "status": "queued"}


@router.get("/{recording_id}/diarization")
def get_diarization(recording_id: int, session: Session = Depends(get_session)) -> dict:
    run = session.exec(
        select(DiarizationRun)
        .where(DiarizationRun.recording_id == recording_id, DiarizationRun.is_active == True)  # noqa: E712
    ).first()
    if not run:
        raise HTTPException(404, "Noch keine Diarisierung vorhanden")

    segments = session.exec(
        select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)
    ).all()

    transcript = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).first()
    words = (
        session.exec(
            select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
        ).all()
        if transcript
        else []
    )

    # Resolve display names for raw speaker labels (Stage D renames).
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}

    # Adapt DB rows to the alignment dataclass (which uses `.speaker`).
    aligned_segments = [
        SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker_label) for s in segments
    ]

    # Stage D overlay (merge + reassign), applied on read.
    relabel, reassigns = load_overlay(session, recording_id)
    utterances = build_utterances(words, aligned_segments, reassigns, relabel)

    # Effective speakers after merges/reassigns, in first-appearance order.
    effective: list[str] = []
    for u in utterances:
        if u.speaker not in effective:
            effective.append(u.speaker)
    for sp in sorted({relabel.get(s.speaker_label, s.speaker_label) for s in segments}):
        if sp not in effective:
            effective.append(sp)
    speakers = effective

    return {
        "run_id": run.id,
        "model": run.model,
        "params": json.loads(run.params_json or "{}"),
        "num_speakers": run.num_speakers,
        "speakers": [{"label": sp, "name": name_map.get(sp, sp)} for sp in speakers],
        "utterances": [
            {
                "speaker": u.speaker,
                "name": name_map.get(u.speaker, u.speaker),
                "start": u.start,
                "end": u.end,
                "text": u.text,
            }
            for u in utterances
        ],
        # Speaker turns (with merges applied) for waveform views.
        "segments": [
            {
                "speaker": relabel.get(s.speaker_label, s.speaker_label),
                "start": s.start,
                "end": s.end,
            }
            for s in segments
        ],
    }

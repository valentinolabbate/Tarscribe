"""Quality review and non-destructive transcript correction endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import enqueue_embedding
from ..models import Recording, TranscriptCorrection
from ..transcript_quality import analyze_words, quality_summary
from ..transcript_view import load_effective_words, load_raw_words

router = APIRouter(tags=["quality"])


class CorrectionIn(BaseModel):
    expected_revision: int = Field(ge=0)
    start_word_idx: int = Field(ge=0)
    end_word_idx: int = Field(ge=0)
    expected_original_text: str = Field(min_length=1, max_length=2000)
    corrected_text: str = Field(min_length=1, max_length=2000)


def _snapshot_or_404(session: Session, recording_id: int):
    if not session.get(Recording, recording_id):
        raise HTTPException(404, "Aufnahme nicht gefunden")
    snapshot = load_raw_words(session, recording_id)
    if snapshot is None:
        raise HTTPException(404, "Noch kein Transkript vorhanden")
    return snapshot


def _report(session: Session, recording_id: int) -> dict:
    loaded = load_effective_words(session, recording_id)
    if loaded is None:
        raise HTTPException(404, "Noch kein Transkript vorhanden")
    snapshot, words = loaded
    issues = analyze_words(words, transcript_id=snapshot.transcript.id or 0, revision=snapshot.transcript.revision)
    corrections = session.exec(
        select(TranscriptCorrection)
        .where(TranscriptCorrection.recording_id == recording_id)
        .order_by(TranscriptCorrection.created_at.desc())
    ).all()
    return {
        "transcript_id": snapshot.transcript.id,
        "revision": snapshot.transcript.revision,
        "quality": quality_summary(words, issues),
        "issues": [issue.serialize() for issue in issues],
        "corrections": [_serialize_correction(correction) for correction in corrections],
    }


def _serialize_correction(correction: TranscriptCorrection) -> dict:
    return {
        "id": correction.id,
        "start_word_idx": correction.start_word_idx,
        "end_word_idx": correction.end_word_idx,
        "start_sec": correction.start_sec,
        "end_sec": correction.end_sec,
        "original_text": correction.original_text,
        "corrected_text": correction.corrected_text,
        "status": correction.status,
        "source": correction.source,
    }


@router.get("/api/recordings/{recording_id}/quality")
def recording_quality(recording_id: int, session: Session = Depends(get_session)) -> dict:
    return _report(session, recording_id)


@router.get("/api/recordings/{recording_id}/corrections")
def corrections(recording_id: int, session: Session = Depends(get_session)) -> list[dict]:
    _snapshot_or_404(session, recording_id)
    return _report(session, recording_id)["corrections"]


@router.post("/api/recordings/{recording_id}/corrections")
def create_correction(
    recording_id: int, payload: CorrectionIn, session: Session = Depends(get_session)
) -> dict:
    snapshot = _snapshot_or_404(session, recording_id)
    if payload.end_word_idx < payload.start_word_idx:
        raise HTTPException(422, "Ungültiger Wortbereich")
    if snapshot.transcript.revision != payload.expected_revision:
        raise HTTPException(409, "Transkript wurde inzwischen geändert")
    span = [word for word in snapshot.words if payload.start_word_idx <= word.idx <= payload.end_word_idx]
    if not span or span[0].idx != payload.start_word_idx or span[-1].idx != payload.end_word_idx:
        raise HTTPException(422, "Wortbereich existiert nicht mehr")
    raw_text = "".join(word.text for word in span)
    if raw_text != payload.expected_original_text:
        raise HTTPException(409, "Der ursprüngliche Text stimmt nicht mehr überein")
    corrected = payload.corrected_text
    if not corrected.strip():
        raise HTTPException(422, "Die Korrektur darf nicht leer sein")
    existing = session.exec(
        select(TranscriptCorrection).where(
            TranscriptCorrection.recording_id == recording_id,
            TranscriptCorrection.status == "active",
            TranscriptCorrection.start_word_idx <= payload.end_word_idx,
            TranscriptCorrection.end_word_idx >= payload.start_word_idx,
        )
    ).all()
    if existing:
        identical = next(
            (
                correction
                for correction in existing
                if correction.start_word_idx == payload.start_word_idx
                and correction.end_word_idx == payload.end_word_idx
                and correction.corrected_text == corrected
            ),
            None,
        )
        if identical:
            return {"correction": _serialize_correction(identical), "transcript_revision": snapshot.transcript.revision, "reindex_scheduled": False, "quality_summary": _report(session, recording_id)["quality"]}
        raise HTTPException(409, "Die Korrektur überlappt mit einer bestehenden Änderung")
    correction = TranscriptCorrection(
        recording_id=recording_id,
        source_transcript_id=snapshot.transcript.id,
        source_revision=snapshot.transcript.revision,
        start_word_idx=payload.start_word_idx,
        end_word_idx=payload.end_word_idx,
        start_sec=span[0].start,
        end_sec=span[-1].end,
        original_text=raw_text,
        corrected_text=corrected,
        context_before="".join(word.text for word in snapshot.words[max(0, payload.start_word_idx - 5):payload.start_word_idx]),
        context_after="".join(word.text for word in snapshot.words[payload.end_word_idx + 1:payload.end_word_idx + 6]),
    )
    snapshot.transcript.revision += 1
    session.add(correction)
    session.add(snapshot.transcript)
    session.commit()
    session.refresh(correction)
    reindex_job = enqueue_embedding(recording_id)
    report = _report(session, recording_id)
    return {
        "correction": _serialize_correction(correction),
        "transcript_revision": snapshot.transcript.revision,
        "reindex_scheduled": reindex_job is not None,
        "quality_summary": report["quality"],
    }


@router.delete("/api/recordings/{recording_id}/corrections/{correction_id}")
def delete_correction(
    recording_id: int, correction_id: int, session: Session = Depends(get_session)
) -> dict:
    snapshot = _snapshot_or_404(session, recording_id)
    correction = session.get(TranscriptCorrection, correction_id)
    if not correction or correction.recording_id != recording_id:
        raise HTTPException(404, "Korrektur nicht gefunden")
    session.delete(correction)
    snapshot.transcript.revision += 1
    session.add(snapshot.transcript)
    session.commit()
    reindex_job = enqueue_embedding(recording_id)
    return {"ok": True, "transcript_revision": snapshot.transcript.revision, "reindex_scheduled": reindex_job is not None}

"""Known-speaker library (voiceprints): enroll, list, match."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..ml.embedding import embed_speaker_segments, from_blob, to_blob, update_mean
from ..ml.speaker_matching import apply_matches, match_recording
from ..models import KnownSpeaker, Recording, SpeakerLabel
from ..security import require_token
from ..settings_store import load_prefs

router = APIRouter(tags=["speakers"], dependencies=[Depends(require_token)])


class KnownSpeakerOut(BaseModel):
    id: int
    name: str
    color: str
    sample_count: int


class EnrollIn(BaseModel):
    name: str
    color: str | None = None
    known_speaker_id: int | None = None  # add a sample to an existing speaker


class UpdateSpeakerIn(BaseModel):
    name: str | None = None
    color: str | None = None


def _out(k: KnownSpeaker) -> KnownSpeakerOut:
    return KnownSpeakerOut(id=k.id, name=k.name, color=k.color, sample_count=k.sample_count)


@router.get("/api/known-speakers")
def list_known(session: Session = Depends(get_session)) -> list[KnownSpeakerOut]:
    return [_out(k) for k in session.exec(select(KnownSpeaker).order_by(KnownSpeaker.name)).all()]


@router.patch("/api/known-speakers/{speaker_id}")
def update_known(
    speaker_id: int, payload: UpdateSpeakerIn, session: Session = Depends(get_session)
) -> KnownSpeakerOut:
    k = session.get(KnownSpeaker, speaker_id)
    if not k:
        raise HTTPException(404, "Sprecher nicht gefunden")
    if payload.name is not None:
        k.name = payload.name
    if payload.color is not None:
        k.color = payload.color
    session.add(k)
    session.commit()
    session.refresh(k)
    return _out(k)


@router.delete("/api/known-speakers/{speaker_id}", status_code=204)
def delete_known(speaker_id: int, session: Session = Depends(get_session)) -> None:
    k = session.get(KnownSpeaker, speaker_id)
    if not k:
        raise HTTPException(404, "Sprecher nicht gefunden")
    session.delete(k)
    session.commit()


@router.post("/api/recordings/{recording_id}/speakers/{label}/enroll")
def enroll_from_label(
    recording_id: int,
    label: str,
    payload: EnrollIn,
    session: Session = Depends(get_session),
) -> KnownSpeakerOut:
    """Build/extend a voiceprint from a diarized speaker in this recording."""
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")

    from ..ml.speaker_matching import cluster_segments

    clusters = cluster_segments(session, recording_id)
    segs = clusters.get(label)
    if not segs:
        raise HTTPException(404, "Keine Segmente für diesen Sprecher")

    try:
        emb = embed_speaker_segments(Path(rec.audio_path), segs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Embedding fehlgeschlagen: {exc}") from exc

    if payload.known_speaker_id:
        k = session.get(KnownSpeaker, payload.known_speaker_id)
        if not k:
            raise HTTPException(404, "Bekannter Sprecher nicht gefunden")
        prev = from_blob(k.embedding_blob) if k.embedding_blob else None
        k.embedding_blob = to_blob(update_mean(prev, k.sample_count, emb))
        k.sample_count += 1
    else:
        k = KnownSpeaker(
            name=payload.name.strip() or "Sprecher",
            color=payload.color or "#10b981",
            embedding_blob=to_blob(emb),
            sample_count=1,
        )
    session.add(k)
    session.commit()
    session.refresh(k)

    # Link this recording's label to the known speaker + name it.
    sl = session.exec(
        select(SpeakerLabel).where(
            SpeakerLabel.recording_id == recording_id, SpeakerLabel.original_label == label
        )
    ).first()
    if sl is None:
        sl = SpeakerLabel(recording_id=recording_id, original_label=label)
    sl.display_name = k.name
    sl.known_speaker_id = k.id
    session.add(sl)
    session.commit()

    from ..ml.lifecycle import unload_all

    unload_all()
    return _out(k)


@router.post("/api/recordings/{recording_id}/match")
def match_now(recording_id: int, session: Session = Depends(get_session)) -> dict:
    """Re-run auto-matching of this recording's speakers against the library."""
    threshold = float(load_prefs().get("speaker_match_threshold", 0.5))
    matches = match_recording(session, recording_id, threshold)
    apply_matches(session, recording_id, matches)

    from ..ml.lifecycle import unload_all

    unload_all()
    return {"matches": matches}

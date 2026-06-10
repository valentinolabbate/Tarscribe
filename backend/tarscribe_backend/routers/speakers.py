"""Known-speaker library (voiceprints): enroll, list, match."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
import numpy as np
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import jobs
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


def _clean_name(name: str) -> str:
    return " ".join(name.split()).strip()


def _name_key(name: str) -> str:
    return _clean_name(name).casefold()


def _embedding_sample_count(k: KnownSpeaker) -> int:
    return k.sample_count if k.sample_count > 0 else (1 if k.embedding_blob else 0)


def _merge_voiceprint(into: KnownSpeaker, duplicate: KnownSpeaker) -> None:
    into_count = _embedding_sample_count(into)
    duplicate_count = _embedding_sample_count(duplicate)

    if into.embedding_blob and duplicate.embedding_blob:
        a = from_blob(into.embedding_blob)
        b = from_blob(duplicate.embedding_blob)
        total = into_count + duplicate_count
        if total > 0:
            merged = (a * into_count + b * duplicate_count) / total
            norm = np.linalg.norm(merged)
            if norm > 0:
                merged = merged / norm
            into.embedding_blob = to_blob(merged)
    elif duplicate.embedding_blob and not into.embedding_blob:
        into.embedding_blob = duplicate.embedding_blob

    into.sample_count = into_count + duplicate_count


def _merge_known_speaker(
    session: Session, survivor: KnownSpeaker, duplicate: KnownSpeaker
) -> KnownSpeaker:
    if survivor.id == duplicate.id:
        return survivor

    _merge_voiceprint(survivor, duplicate)
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.known_speaker_id == duplicate.id)
    ).all()
    for label in labels:
        label.known_speaker_id = survivor.id
        label.display_name = survivor.name
        session.add(label)
    session.add(survivor)
    session.delete(duplicate)
    session.flush()
    return survivor


def _dedupe_known_speakers_by_name(
    session: Session, preferred: KnownSpeaker | None = None
) -> KnownSpeaker | None:
    speakers = list(session.exec(select(KnownSpeaker).order_by(KnownSpeaker.id)).all())
    by_name: dict[str, list[KnownSpeaker]] = {}
    for speaker in speakers:
        key = _name_key(speaker.name)
        if key:
            by_name.setdefault(key, []).append(speaker)

    preferred_result: KnownSpeaker | None = preferred
    for group in by_name.values():
        if len(group) < 2:
            continue
        survivor = preferred if preferred is not None and preferred in group else group[0]
        for duplicate in group:
            if duplicate.id != survivor.id:
                _merge_known_speaker(session, survivor, duplicate)
        if preferred is not None and survivor.id == preferred.id:
            preferred_result = survivor
    return preferred_result


def _find_known_speaker_by_name(session: Session, name: str) -> KnownSpeaker | None:
    key = _name_key(name)
    if not key:
        return None
    for speaker in session.exec(select(KnownSpeaker).order_by(KnownSpeaker.id)).all():
        if _name_key(speaker.name) == key:
            return speaker
    return None


def _add_embedding_sample(k: KnownSpeaker, emb: np.ndarray) -> None:
    prev = from_blob(k.embedding_blob) if k.embedding_blob else None
    k.embedding_blob = to_blob(update_mean(prev, k.sample_count, emb))
    k.sample_count += 1


@router.get("/api/known-speakers")
def list_known(session: Session = Depends(get_session)) -> list[KnownSpeakerOut]:
    _dedupe_known_speakers_by_name(session)
    session.commit()
    return [_out(k) for k in session.exec(select(KnownSpeaker).order_by(KnownSpeaker.name)).all()]


@router.patch("/api/known-speakers/{speaker_id}")
def update_known(
    speaker_id: int, payload: UpdateSpeakerIn, session: Session = Depends(get_session)
) -> KnownSpeakerOut:
    k = session.get(KnownSpeaker, speaker_id)
    if not k:
        raise HTTPException(404, "Sprecher nicht gefunden")
    if payload.name is not None:
        k.name = _clean_name(payload.name) or "Sprecher"
    if payload.color is not None:
        k.color = payload.color
    session.add(k)
    session.flush()
    k = _dedupe_known_speakers_by_name(session, preferred=k) or k
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
        _add_embedding_sample(k, emb)
    else:
        name = _clean_name(payload.name) or "Sprecher"
        k = _find_known_speaker_by_name(session, name)
        if k is not None:
            k.name = name
            k = _dedupe_known_speakers_by_name(session, preferred=k) or k
            _add_embedding_sample(k, emb)
        else:
            k = KnownSpeaker(
                name=name,
                color=payload.color or "#10b981",
                embedding_blob=to_blob(emb),
                sample_count=1,
            )
    session.add(k)
    session.flush()
    k = _dedupe_known_speakers_by_name(session, preferred=k) or k
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
    jobs.schedule_reindex(recording_id)

    from ..ml.lifecycle import unload_all

    unload_all()
    return _out(k)


@router.post("/api/recordings/{recording_id}/match")
def match_now(recording_id: int, session: Session = Depends(get_session)) -> dict:
    """Re-run auto-matching of this recording's speakers against the library."""
    threshold = float(load_prefs().get("speaker_match_threshold", 0.5))
    matches = match_recording(session, recording_id, threshold)
    apply_matches(session, recording_id, matches)
    jobs.schedule_reindex(recording_id)

    from ..ml.lifecycle import unload_all

    unload_all()
    return {"matches": matches}

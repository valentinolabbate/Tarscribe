"""Match diarized speaker clusters to the known-speaker library."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from sqlmodel import Session, select

from ..models import DiarizationRun, KnownSpeaker, Recording, Segment, SpeakerLabel
from .embedding import cosine, embed_speaker_segments, from_blob


def cluster_segments(session: Session, recording_id: int) -> dict[str, list[tuple[float, float]]]:
    """Return {speaker_label: [(start, end), ...]} for the active diarization run."""
    run = session.exec(
        select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id, DiarizationRun.is_active == True  # noqa: E712
        )
    ).first()
    if not run:
        return {}
    by_label: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for seg in session.exec(select(Segment).where(Segment.run_id == run.id)).all():
        by_label[seg.speaker_label].append((seg.start, seg.end))
    return by_label


def match_recording(
    session: Session, recording_id: int, threshold: float
) -> list[dict]:
    """For each diarized speaker, find the best known-speaker match above threshold."""
    rec = session.get(Recording, recording_id)
    if not rec:
        return []
    known = [k for k in session.exec(select(KnownSpeaker)).all() if k.embedding_blob]
    if not known:
        return []

    audio = Path(rec.audio_path)
    clusters = cluster_segments(session, recording_id)
    results: list[dict] = []
    for label, segs in clusters.items():
        try:
            emb = embed_speaker_segments(audio, segs)
        except Exception:
            continue
        best_k = None
        best_score = -1.0
        for k in known:
            score = cosine(emb, from_blob(k.embedding_blob))
            if score > best_score:
                best_score = score
                best_k = k
        if best_k is not None and best_score >= threshold:
            results.append(
                {"label": label, "known_speaker_id": best_k.id, "name": best_k.name, "score": best_score}
            )
    return results


def apply_matches(session: Session, recording_id: int, matches: list[dict]) -> None:
    """Write auto-matches as SpeakerLabel rows (without clobbering manual names)."""
    for m in matches:
        existing = session.exec(
            select(SpeakerLabel).where(
                SpeakerLabel.recording_id == recording_id,
                SpeakerLabel.original_label == m["label"],
            )
        ).first()
        if existing and existing.display_name:
            continue  # respect a manual rename
        if existing is None:
            existing = SpeakerLabel(recording_id=recording_id, original_label=m["label"])
        existing.display_name = m["name"]
        existing.known_speaker_id = m["known_speaker_id"]
        session.add(existing)
    session.commit()

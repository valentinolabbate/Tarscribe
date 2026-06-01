"""Rolling-window diarization for live recording sessions.

Responsibilities:
- Run pyannote on a rolling WAV window (plan §4.5).
- Map window-local speaker labels to stable session cluster IDs via temporal overlap.
- Attempt known-speaker matching with hysteresis (plan §4.6).
- Expose ``assign_speakers_to_words`` for transcript annotation.

Callers hold ``ml.lifecycle.diar_lock`` for the duration of ``run_window`` and
``match_known_speakers`` to serialise GPU/CPU access with final diarization jobs.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .diarization import SpeakerSegment

# Rolling window parameters (plan §4.5).
DIAR_WINDOW_SEC: float = 40.0
DIAR_OVERLAP_SEC: float = 15.0
DIAR_MIN_AUDIO_SEC: float = 5.0

# Known-speaker matching (plan §4.6).
MATCH_MIN_SPEECH_SEC: float = 4.0
MATCH_MIN_CONSECUTIVE: int = 2   # required before showing as "probable"
MATCH_OVERLAP_THRESHOLD: float = 0.3  # minimum overlap (s) for cluster identity


@dataclass
class LiveCluster:
    """Session-scoped stable speaker identity."""

    id: str               # e.g. "live-speaker-1"
    display_name: str     # "Sprecher 1" or matched known-speaker name
    known_speaker_id: int | None = None
    similarity: float | None = None
    match_status: str = "none"   # "none" | "probable"
    total_speech_sec: float = 0.0
    consecutive_matches: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "known_speaker_id": self.known_speaker_id,
            "similarity": round(self.similarity, 3) if self.similarity is not None else None,
            "match_status": self.match_status,
        }


@dataclass
class LiveSegment:
    """Speaker segment in global session time."""

    start: float
    end: float
    speaker_id: str  # e.g. "live-speaker-1"


@dataclass
class DiarizationState:
    """Mutable state maintained across rolling-window ticks."""

    clusters: dict[str, LiveCluster] = field(default_factory=dict)
    segments: list[LiveSegment] = field(default_factory=list)
    next_idx: int = 1
    last_window_end: float = 0.0

    def new_cluster(self) -> LiveCluster:
        cid = f"live-speaker-{self.next_idx}"
        c = LiveCluster(id=cid, display_name=f"Sprecher {self.next_idx}")
        self.next_idx += 1
        self.clusters[cid] = c
        return c


# ── Internal helpers ─────────────────────────────────────────────────────────

def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _map_labels(
    new_global: list[tuple[float, float, str]],
    state: DiarizationState,
    overlap_start: float,
    overlap_end: float,
) -> dict[str, str]:
    """Map pyannote window-local labels to stable live-speaker IDs via temporal overlap."""
    stable_in_zone = [
        s for s in state.segments
        if s.end > overlap_start and s.start < overlap_end
    ]

    new_labels = {label for *_, label in new_global}
    assigned: dict[str, str] = {}
    used: set[str] = set()

    for label in sorted(new_labels):
        new_in_zone = [
            (s, e) for s, e, l in new_global
            if l == label and e > overlap_start and s < overlap_end
        ]
        if not new_in_zone:
            assigned[label] = state.new_cluster().id
            continue

        best_id: str | None = None
        best_ov = 0.0
        for stab in stable_in_zone:
            if stab.speaker_id in used:
                continue
            for ns, ne in new_in_zone:
                ov = _overlap(ns, ne, stab.start, stab.end)
                if ov > best_ov:
                    best_ov = ov
                    best_id = stab.speaker_id

        if best_id and best_ov >= MATCH_OVERLAP_THRESHOLD:
            assigned[label] = best_id
            used.add(best_id)
        else:
            assigned[label] = state.new_cluster().id

    return assigned


# ── Public API ───────────────────────────────────────────────────────────────

def run_window(
    pcm_path: Path,
    current_duration_sec: float,
    state: DiarizationState,
    diarize_fn: Callable[[Path], list[SpeakerSegment]],
    sample_rate: int,
    channels: int,
) -> DiarizationState:
    """Run diarization on the rolling window and update ``state`` in place.

    ``diarize_fn`` is typically ``DiarizationBackend.diarize``, kept warm by the caller.
    """
    import tempfile

    from ..live_audio import build_wav_window

    if current_duration_sec < DIAR_MIN_AUDIO_SEC:
        return state

    window_start = max(0.0, current_duration_sec - DIAR_WINDOW_SEC)
    window_end = current_duration_sec
    overlap_start = max(window_start, state.last_window_end - DIAR_OVERLAP_SEC)
    overlap_end = state.last_window_end

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = Path(tmp.name)

    try:
        ok = build_wav_window(pcm_path, window_start, window_end, sample_rate, channels, wav_path)
        if not ok:
            return state

        raw_segs = diarize_fn(wav_path)

        global_segs: list[tuple[float, float, str]] = [
            (round(window_start + s.start, 3), round(window_start + s.end, 3), s.speaker)
            for s in raw_segs
        ]

        if state.last_window_end == 0.0:
            # First run — every label is a new cluster.
            mapping: dict[str, str] = {}
            for label in {l for *_, l in global_segs}:
                mapping[label] = state.new_cluster().id
        else:
            mapping = _map_labels(global_segs, state, overlap_start, overlap_end)

        # Merge: retain stable segments before overlap zone, remap new segments after it.
        merged: list[LiveSegment] = [s for s in state.segments if s.end <= overlap_start]
        for gs, ge, gl in global_segs:
            if gs >= overlap_start:
                merged.append(LiveSegment(
                    start=gs, end=ge, speaker_id=mapping.get(gl, gl)
                ))
        merged.sort(key=lambda s: s.start)

        for c in state.clusters.values():
            c.total_speech_sec = sum(
                s.end - s.start for s in merged if s.speaker_id == c.id
            )

        state.segments = merged
        state.last_window_end = window_end
        return state

    finally:
        wav_path.unlink(missing_ok=True)


def match_known_speakers(
    state: DiarizationState,
    pcm_path: Path,
    current_duration_sec: float,
    sample_rate: int,
    channels: int,
    known: list[dict],  # [{id, name, embedding_blob}]
    threshold: float,
) -> None:
    """Embed eligible live clusters and match against known-speaker library.

    Applies hysteresis (MATCH_MIN_CONSECUTIVE) before showing a match as "probable".
    Modifies ``state.clusters`` in place.
    """
    if not known or not pcm_path.exists():
        return

    import tempfile

    from .embedding import cosine, embed_speaker_segments, from_blob
    from ..live_audio import build_wav_window

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = Path(tmp.name)

    try:
        ok = build_wav_window(pcm_path, 0.0, current_duration_sec, sample_rate, channels, wav_path)
        if not ok:
            return

        for cluster in state.clusters.values():
            if cluster.total_speech_sec < MATCH_MIN_SPEECH_SEC:
                continue

            segs = [
                (s.start, s.end)
                for s in state.segments
                if s.speaker_id == cluster.id and (s.end - s.start) >= 0.3
            ]
            if not segs:
                continue

            try:
                emb = embed_speaker_segments(wav_path, segs)
            except Exception:
                continue

            best_id: int | None = None
            best_score = -1.0
            best_name = ""
            for ks in known:
                if not ks.get("embedding_blob"):
                    continue
                score = cosine(emb, from_blob(ks["embedding_blob"]))
                if score > best_score:
                    best_score = score
                    best_id = ks["id"]
                    best_name = ks["name"]

            if best_id is not None and best_score >= threshold:
                if cluster.known_speaker_id == best_id:
                    cluster.consecutive_matches += 1
                else:
                    cluster.consecutive_matches = 1
                cluster.known_speaker_id = best_id
                cluster.similarity = best_score
                if cluster.consecutive_matches >= MATCH_MIN_CONSECUTIVE:
                    cluster.display_name = best_name
                    cluster.match_status = "probable"
            else:
                cluster.consecutive_matches = max(0, cluster.consecutive_matches - 1)
                if cluster.consecutive_matches == 0:
                    cluster.match_status = "none"
                    cluster.known_speaker_id = None
                    cluster.similarity = None

    finally:
        wav_path.unlink(missing_ok=True)


def assign_speakers_to_words(
    words: list[dict], segments: list[LiveSegment]
) -> list[dict]:
    """Return a copy of ``words`` with ``speaker_id`` filled from diarization segments."""
    if not segments:
        return words

    result = []
    for word in words:
        w0 = word.get("start", 0.0)
        w1 = word.get("end", 0.0)
        best_spk: str | None = None
        best_ov = 0.0
        for seg in segments:
            ov = _overlap(w0, w1, seg.start, seg.end)
            if ov > best_ov:
                best_ov = ov
                best_spk = seg.speaker_id
        result.append({**word, "speaker_id": best_spk})
    return result

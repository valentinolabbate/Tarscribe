"""Rolling-window ASR for live recording sessions.

Caller must hold ``ml.lifecycle.asr_lock`` for the duration of each call so that
the shared ASR singleton is never accessed from two threads simultaneously.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from ..live_audio import build_wav_window
from .asr.factory import get_backend

# Configurable defaults (plan §10, §4.4).
WINDOW_SEC: float = 25.0       # rolling ASR window
STABLE_HORIZON_SEC: float = 6.0  # words older than this are frozen


def analyze_window(
    pcm_path: Path,
    session_id: str,
    current_duration_sec: float,
    previous_words: list[dict],
    sample_rate: int,
    channels: int,
    language: str | None = None,
) -> list[dict]:
    """Run ASR on the last WINDOW_SEC of audio and merge with the stable prefix.

    Returns the new word list: frozen stable words + fresh provisional tail.
    """
    stable_cutoff = max(0.0, current_duration_sec - STABLE_HORIZON_SEC)

    # Preserve words that have passed the stability horizon (their timestamps won't change).
    stable_words: list[dict] = []
    for w in previous_words:
        if w.get("end", 0.0) <= stable_cutoff:
            copy = dict(w)
            copy["is_final"] = True
            stable_words.append(copy)

    window_start = max(0.0, current_duration_sec - WINDOW_SEC)
    window_end = current_duration_sec

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        ok = build_wav_window(pcm_path, window_start, window_end, sample_rate, channels, tmp_path)
        if not ok:
            return stable_words

        backend = get_backend()
        result = backend.transcribe(tmp_path, language=language)

        provisional: list[dict] = []
        for w in result.words:
            g_start = round(window_start + w.start, 3)
            g_end = round(window_start + w.end, 3)
            if g_end <= stable_cutoff:
                continue  # already covered by stable_words
            provisional.append({
                "id": f"live-{session_id}-{int(g_start * 1000)}",
                "start": g_start,
                "end": g_end,
                "text": w.text,
                "confidence": round(w.confidence, 3) if w.confidence is not None else None,
                "is_final": False,
                "speaker_id": None,
            })

        return stable_words + provisional

    finally:
        tmp_path.unlink(missing_ok=True)

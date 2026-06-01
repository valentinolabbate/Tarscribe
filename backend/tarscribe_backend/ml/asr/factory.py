"""Pick and cache the best ASR backend for this machine."""

from __future__ import annotations

from ...config import get_settings
from ...hardware import detect_hardware
from .base import ASRBackend

_cached: ASRBackend | None = None
_cached_key: str | None = None


def build_backend(override: str | None = None) -> ASRBackend:
    """Construct the ASR backend. ``override`` forces a specific engine name."""
    hw = detect_hardware()
    settings = get_settings()
    engine = override or hw.recommended_asr

    if engine == "parakeet-mlx":
        from .parakeet_mlx_backend import ParakeetMlxBackend

        return ParakeetMlxBackend()

    # faster-whisper for CUDA / CPU.
    from .faster_whisper_backend import FasterWhisperBackend

    return FasterWhisperBackend(
        model_size="large-v3",
        device=hw.recommended_device if hw.recommended_device in ("cuda", "cpu") else "cpu",
        compute_type=hw.recommended_precision,
        models_dir=str(settings.models_dir),
    )


def get_backend(override: str | None = None) -> ASRBackend:
    """Return a cached backend for the duration of a job (unloaded afterwards)."""
    global _cached, _cached_key
    key = override or "auto"
    if _cached is None or _cached_key != key:
        _cached = build_backend(override)
        _cached_key = key
    return _cached


def unload_backend() -> None:
    """Drop the cached ASR model so its memory can be reclaimed."""
    global _cached, _cached_key
    _cached = None
    _cached_key = None

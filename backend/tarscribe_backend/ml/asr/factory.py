"""Pick and cache the best ASR backend for this machine."""

from __future__ import annotations

import json

from ...config import get_settings
from ...hardware import detect_hardware
from ...performance_profiles import resolve_asr_selection
from ...settings_store import load_prefs
from .base import ASRBackend

_cached: ASRBackend | None = None
_cached_key: str | None = None


def _selection(override: str | None = None) -> dict:
    hw = detect_hardware()
    return resolve_asr_selection(load_prefs(), hw, override=override)


def build_backend(override: str | None = None, selection: dict | None = None) -> ASRBackend:
    """Construct the ASR backend. ``override`` forces a specific engine name."""
    settings = get_settings()
    selection = selection or _selection(override)
    engine = selection["engine"]

    if engine == "parakeet-mlx":
        from .parakeet_mlx_backend import DEFAULT_MODEL, ParakeetMlxBackend

        return ParakeetMlxBackend(
            model_id=selection.get("model_id") or DEFAULT_MODEL,
            chunk_seconds=float(selection.get("chunk_seconds") or 120.0),
            overlap_seconds=float(selection.get("overlap_seconds") or 15.0),
        )

    # faster-whisper for CUDA / CPU.
    from .faster_whisper_backend import FasterWhisperBackend

    return FasterWhisperBackend(
        model_size=selection.get("model_size") or "medium",
        device=selection.get("device") or "cpu",
        compute_type=selection.get("compute_type") or "int8",
        models_dir=str(settings.models_dir),
    )


def get_backend(override: str | None = None) -> ASRBackend:
    """Return a cached backend for the duration of a job (unloaded afterwards)."""
    global _cached, _cached_key
    selection = _selection(override)
    key = json.dumps(selection, sort_keys=True)
    if _cached is None or _cached_key != key:
        _cached = build_backend(override, selection=selection)
        _cached_key = key
    return _cached


def unload_backend() -> None:
    """Drop the cached ASR model so its memory can be reclaimed."""
    global _cached, _cached_key
    _cached = None
    _cached_key = None

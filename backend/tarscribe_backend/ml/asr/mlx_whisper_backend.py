"""mlx-whisper backend for Whisper models on Apple Silicon GPU/Metal."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ...performance_profiles import DEFAULT_MLX_WHISPER_MODEL
from .base import ProgressCb, TranscriptResult, WordSeg


class MlxWhisperBackend:
    name = "mlx-whisper"

    def __init__(self, model_id: str = DEFAULT_MLX_WHISPER_MODEL) -> None:
        self.model_id = model_id

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        progress: ProgressCb | None = None,
    ) -> TranscriptResult:
        if progress:
            progress(0.02, "Lade MLX-Whisper-Modell…")

        import mlx_whisper  # lazy, heavy import

        kwargs: dict[str, Any] = {
            "path_or_hf_repo": _offline_ref(self.model_id),
            "word_timestamps": True,
        }
        if language:
            kwargs["language"] = language

        result = mlx_whisper.transcribe(str(audio_path), **kwargs)
        if progress:
            progress(0.99, "Transkription abgeschlossen…")

        return TranscriptResult(
            language=_get(result, "language", None) or language,
            words=_extract_words(result),
            model=f"{self.name}:{self.model_id}",
        )


def _offline_ref(model_id: str) -> str:
    """Prefer an already-cached MLX Whisper snapshot over an online HF lookup."""
    if os.path.isdir(model_id):
        return model_id
    try:
        from huggingface_hub import hf_hub_download

        config = hf_hub_download(model_id, "config.json", local_files_only=True)
        for filename in ("weights.npz", "weights.safetensors"):
            try:
                hf_hub_download(model_id, filename, local_files_only=True)
                return str(Path(config).parent)
            except Exception:  # noqa: BLE001 - try the other common MLX weight name
                pass
    except Exception:  # noqa: BLE001 - not cached yet -> let mlx-whisper download once
        pass
    return model_id


def _extract_words(result: Any) -> list[WordSeg]:
    words: list[WordSeg] = []
    last_end = 0.0
    segments = _get(result, "segments", []) or []

    for segment in segments:
        segment_words = _get(segment, "words", None) or []
        if segment_words:
            for item in segment_words:
                text = str(_first(item, "word", "text") or "")
                if not text.strip():
                    continue
                start, end = _coerce_span(item, last_end)
                words.append(
                    WordSeg(
                        start=start,
                        end=end,
                        text=text,
                        confidence=_as_float(_first(item, "probability", "score", "confidence")),
                    )
                )
                last_end = end
            continue

        text = str(_get(segment, "text", "") or "")
        if text.strip():
            start, end = _coerce_span(segment, last_end)
            words.append(WordSeg(start=start, end=end, text=text))
            last_end = end

    return words


def _coerce_span(item: Any, last_end: float) -> tuple[float, float]:
    raw_start = _get(item, "start", None)
    raw_end = _get(item, "end", None)
    start = float(raw_start) if raw_start is not None else last_end
    end = float(raw_end) if raw_end is not None else start
    return start, end


def _first(item: Any, *keys: str) -> Any:
    for key in keys:
        value = _get(item, key, None)
        if value is not None:
            return value
    return None


def _get(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(key, default)
    return getattr(item, key, default)


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

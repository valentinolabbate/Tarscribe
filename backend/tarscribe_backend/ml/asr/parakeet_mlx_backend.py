"""parakeet-mlx backend — best ASR on Apple Silicon (NVIDIA Parakeet via MLX)."""

from __future__ import annotations

from pathlib import Path

from ...audio import probe_duration
from .base import ProgressCb, TranscriptResult, WordSeg

# Parakeet v3: 25 European languages, word/token-level timestamps, very fast on MPS.
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
# Long files are processed in overlapping chunks to bound memory.
CHUNK_SECONDS = 120.0
OVERLAP_SECONDS = 15.0


class ParakeetMlxBackend:
    name = "parakeet-mlx"

    def __init__(self, model_id: str = DEFAULT_MODEL) -> None:
        self.model_id = model_id
        self._model = None

    def _ensure_model(self):
        if self._model is None:
            from parakeet_mlx import from_pretrained  # lazy, heavy import

            self._model = from_pretrained(self.model_id)
        return self._model

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        progress: ProgressCb | None = None,
    ) -> TranscriptResult:
        model = self._ensure_model()
        duration = probe_duration(audio_path) or 0.0
        if progress:
            progress(0.05, "Modell geladen, transkribiere…")

        # parakeet-mlx exposes an optional progress callback as it streams chunks.
        def _cb(done: float, total: float) -> None:
            if progress and total:
                progress(min(0.98, 0.05 + 0.93 * (done / total)), "Transkribiere…")

        kwargs: dict = {}
        if duration > CHUNK_SECONDS:
            kwargs = {"chunk_duration": CHUNK_SECONDS, "overlap_duration": OVERLAP_SECONDS}
        try:
            result = model.transcribe(str(audio_path), chunk_callback=_cb, **kwargs)
        except TypeError:
            # Older/newer signature without chunk_callback.
            result = model.transcribe(str(audio_path), **kwargs)

        words = _extract_words(result)
        return TranscriptResult(language=language, words=words, model=f"{self.name}")


def _extract_words(result) -> list[WordSeg]:
    """Flatten parakeet-mlx AlignedResult sentences/tokens into word segments."""
    words: list[WordSeg] = []
    sentences = getattr(result, "sentences", None) or []
    for sentence in sentences:
        tokens = getattr(sentence, "tokens", None)
        if tokens:
            for tok in tokens:
                words.append(
                    WordSeg(
                        start=float(getattr(tok, "start", 0.0)),
                        end=float(getattr(tok, "end", 0.0)),
                        text=getattr(tok, "text", ""),
                    )
                )
        else:
            words.append(
                WordSeg(
                    start=float(getattr(sentence, "start", 0.0)),
                    end=float(getattr(sentence, "end", 0.0)),
                    text=getattr(sentence, "text", ""),
                )
            )
    return words

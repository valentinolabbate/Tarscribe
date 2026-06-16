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

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        chunk_seconds: float = CHUNK_SECONDS,
        overlap_seconds: float = OVERLAP_SECONDS,
    ) -> None:
        self.model_id = model_id
        self.chunk_seconds = chunk_seconds
        self.overlap_seconds = overlap_seconds
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
        # Chunk long files to bound memory. When the duration is unknown (probe
        # failed), chunk anyway — better a little overlap work than risk loading
        # an arbitrarily long file whole.
        if duration <= 0 or duration > self.chunk_seconds:
            kwargs = {
                "chunk_duration": self.chunk_seconds,
                "overlap_duration": self.overlap_seconds,
            }
        try:
            result = model.transcribe(str(audio_path), chunk_callback=_cb, **kwargs)
        except TypeError as exc:
            # Only fall back for the optional-callback signature mismatch; a real
            # TypeError from inside transcribe must not be silently retried.
            if "chunk_callback" not in str(exc):
                raise
            result = model.transcribe(str(audio_path), **kwargs)

        words = _extract_words(result)
        return TranscriptResult(language=language, words=words, model=f"{self.name}")


def _extract_words(result) -> list[WordSeg]:
    """Flatten parakeet-mlx AlignedResult sentences/tokens into word segments.

    Timestamps are coerced to monotonic floats (tokens occasionally carry
    ``None``) so the downstream NOT NULL Word rows always insert, and empty
    tokens are dropped.
    """
    words: list[WordSeg] = []
    last_end = 0.0
    sentences = getattr(result, "sentences", None) or []
    for sentence in sentences:
        tokens = getattr(sentence, "tokens", None)
        items = tokens if tokens else [sentence]
        for item in items:
            text = getattr(item, "text", "") or ""
            if text == "":
                continue  # keep whitespace tokens (they carry spacing)
            raw_start = getattr(item, "start", None)
            raw_end = getattr(item, "end", None)
            start = float(raw_start) if raw_start is not None else last_end
            end = float(raw_end) if raw_end is not None else start
            words.append(WordSeg(start=start, end=end, text=text))
            last_end = end
    return words

"""faster-whisper backend (CTranslate2) — Windows CUDA / CPU and Linux."""

from __future__ import annotations

from pathlib import Path

from ...audio import probe_duration
from .base import ProgressCb, TranscriptResult, WordSeg


class FasterWhisperBackend:
    name = "faster-whisper"

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "cpu",
        compute_type: str = "int8",
        models_dir: str | None = None,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.models_dir = models_dir
        self._model = None

    def _ensure_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel  # lazy, heavy import

            self._model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
                download_root=self.models_dir,
            )
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
            progress(0.02, "Modell geladen, starte Transkription…")

        segments, info = model.transcribe(
            str(audio_path),
            language=language,
            word_timestamps=True,
            vad_filter=True,
        )

        words: list[WordSeg] = []
        for seg in segments:  # generator — work streams in here
            if seg.words:
                for w in seg.words:
                    words.append(
                        WordSeg(start=w.start, end=w.end, text=w.word, confidence=w.probability)
                    )
            else:
                words.append(WordSeg(start=seg.start, end=seg.end, text=seg.text))
            if progress and duration:
                progress(min(0.98, max(0.02, seg.end / duration)), "Transkribiere…")

        return TranscriptResult(
            language=info.language if info else language,
            words=words,
            model=f"{self.name}:{self.model_size}",
        )

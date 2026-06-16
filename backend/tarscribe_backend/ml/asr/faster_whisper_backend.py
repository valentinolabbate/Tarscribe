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

            kwargs = dict(
                device=self.device,
                compute_type=self.compute_type,
                download_root=self.models_dir,
            )
            try:
                # Offline first: an already-downloaded model loads without the
                # HF etag check, which can hang for over a minute when HF is slow.
                self._model = WhisperModel(self.model_size, local_files_only=True, **kwargs)
            except Exception:  # noqa: BLE001 - not cached yet → download once
                self._model = WhisperModel(self.model_size, local_files_only=False, **kwargs)
        return self._model

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        progress: ProgressCb | None = None,
    ) -> TranscriptResult:
        model = self._ensure_model()
        if progress:
            progress(0.02, "Modell geladen, starte Transkription…")

        words, info = self._collect(model, audio_path, language, vad_filter=True, progress=progress)
        # The voice-activity filter can drop quiet or soft speech to nothing.
        # Rather than return an empty transcript, retry once without it.
        if not words:
            words, info = self._collect(
                model, audio_path, language, vad_filter=False, progress=progress
            )

        return TranscriptResult(
            language=getattr(info, "language", None) or language,
            words=words,
            model=f"{self.name}:{self.model_size}",
        )

    def _collect(self, model, audio_path, language, *, vad_filter, progress):
        segments, info = model.transcribe(
            str(audio_path),
            language=language,
            word_timestamps=True,
            vad_filter=vad_filter,
        )
        # faster-whisper reports a reliable duration up front; fall back to a
        # header probe so the progress denominator is never zero.
        total = float(getattr(info, "duration", 0.0) or 0.0) or probe_duration(audio_path)

        words: list[WordSeg] = []
        last_end = 0.0
        for seg in segments:  # generator — work streams in here
            seg_words = seg.words or []
            if seg_words:
                for w in seg_words:
                    text = w.word or ""
                    if not text.strip():
                        continue
                    # faster-whisper occasionally emits None timestamps; coerce
                    # them to a monotonic value so the NOT NULL Word rows insert.
                    start = float(w.start) if w.start is not None else last_end
                    end = float(w.end) if w.end is not None else start
                    words.append(WordSeg(start=start, end=end, text=text, confidence=w.probability))
                    last_end = end
            else:
                text = seg.text or ""
                if text.strip():
                    start = float(seg.start) if seg.start is not None else last_end
                    end = float(seg.end) if seg.end is not None else start
                    words.append(WordSeg(start=start, end=end, text=text))
                    last_end = end
            if progress and total:
                frac = (seg.end if seg.end is not None else last_end) / total
                progress(min(0.98, max(0.02, frac)), "Transkribiere…")
        return words, info

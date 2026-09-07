from __future__ import annotations

import json
import math
import re
import tempfile
from pathlib import Path

from ...asr_catalog import ALIGNER_MODEL, EXPERIMENTAL_ASR, alignment_language
from .base import ProgressCb, SpeakerSpan, TranscriptResult, WordSeg


def model_path(model_id: str) -> Path:
    from huggingface_hub import snapshot_download

    path = Path(model_id).expanduser()
    if path.is_dir():
        return path
    try:
        path = Path(snapshot_download(model_id, local_files_only=True))
        index = path / "model.safetensors.index.json"
        files = (
            set(json.loads(index.read_text())["weight_map"].values())
            if index.exists()
            else {"model.safetensors"}
        )
        if (path / "config.json").is_file() and all((path / name).is_file() for name in files):
            return path
    except (OSError, ValueError, KeyError):
        pass
    return Path(
        snapshot_download(
            model_id, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja"]
        )
    )


def _load(model_id: str, expected_type: str | None = None):
    from mlx_audio.stt import load

    path = model_path(model_id)
    config = json.loads((path / "config.json").read_text())
    model_type = config.get("model_type")
    if expected_type and model_type != expected_type:
        raise ValueError(
            f"Unpassende Modellarchitektur: erwartet {expected_type}, erhalten {model_type}. "
            "Bitte eine kompatible Modell-ID oder den Engine-Standard wählen."
        )
    kwargs = {"model_type": "vibevoice_asr"} if config.get("model_type") == "vibevoice" else {}
    return load(str(path), **kwargs)


def normalized_language(value, fallback: str | None) -> str | None:
    if isinstance(value, list):
        value = next((item for item in value if item), fallback)
    if not isinstance(value, str):
        return fallback
    from ...asr_catalog import ALIGNMENT_LANGUAGES

    return next(
        (code for code, name in ALIGNMENT_LANGUAGES.items() if name.lower() == value.lower()),
        value.lower(),
    )


def aligned_words(items, duration: float) -> list[WordSeg]:
    words = []
    for item in items:
        text = str(item.text).strip()
        start, end = float(item.start_time), float(item.end_time)
        if not text:
            continue
        if not math.isfinite(start) or not math.isfinite(end) or end < start:
            raise RuntimeError("Das Modell hat ungültige Wort-Zeitmarken geliefert.")
        start, end = min(duration, max(0.0, start)), min(duration, max(0.0, end))
        words.append(WordSeg(start=start, end=end, text=" " + text))
    return words


def speaker_segments(raw, duration: float) -> list[dict]:
    segments = []
    for item in raw or []:
        text = str(item.get("text", item.get("Content", ""))).strip()
        speaker = item.get("speaker_id", item.get("Speaker"))
        start = float(item.get("start", item.get("start_time", item.get("Start", 0))))
        end = float(item.get("end", item.get("end_time", item.get("End", duration))))
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end:
            continue
        if speaker is not None:
            text = re.sub(r"^\[" + re.escape(str(speaker)) + r"\]\s*", "", text)
        if text:
            segments.append(
                {
                    "text": text,
                    "speaker": speaker,
                    "start": min(start, duration),
                    "end": min(end, duration),
                }
            )
    return segments


def parse_streaming_speakers(text: str) -> list[tuple[str | None, str]]:
    parts = re.split(r"(?:^|\n)\s*Speaker\s+(\d+)\s*:", text)
    blocks = [(None, parts[0])] if parts[0].strip() else []
    blocks.extend((parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2))
    return [(speaker, content.strip()) for speaker, content in blocks if content.strip()]


class MlxAudioBackend:
    def __init__(
        self,
        engine: str,
        model_id: str | None = None,
        hotwords: list[str] | None = None,
        chunk_seconds: float = 120.0,
    ):
        self.name = engine
        self.model_id = model_id or str(EXPERIMENTAL_ASR[engine]["model"])
        self.hotwords = hotwords or []
        self.chunk_seconds = max(10.0, min(240.0, chunk_seconds))
        self._model = None
        self._aligner = None
        self._live_session = None
        self._live_key = None

    def transcribe_live(self, pcm_path, session_id, duration, sample_rate, channels, language):
        if self.name not in ("nemotron-mlx", "vibevoice-mlx"):
            return None
        from .native_streaming import NativeSession

        key = (session_id, str(pcm_path), sample_rate, channels, language)
        if self._live_key != key or (
            self._live_session and self._live_session.read_samples > duration * sample_rate
        ):
            self._live_session = NativeSession(self, sample_rate, channels, language)
            self._live_key = key
        return self._live_session.read(pcm_path, duration)

    def _ensure_model(self):
        if self._model is None:
            expected = {
                "qwen3-mlx": "qwen3_asr",
                "nemotron-mlx": "nemotron_asr",
                "moss-mlx": "moss_transcribe_diarize",
                "vibevoice-mlx": "vibevoice",
            }[self.name]
            self._model = _load(self.model_id, expected)
        return self._model

    def _align(self, audio, text: str, language: str, duration: float):
        if not text.strip():
            return []
        if self._aligner is None:
            self._aligner = _load(ALIGNER_MODEL)
        import mlx.core as mx

        result = self._aligner.generate(
            mx.array(audio), text=text, language=alignment_language(language)
        )
        return aligned_words(result, duration)

    def prepare(self):
        self._ensure_model()
        if EXPERIMENTAL_ASR[self.name]["alignment"]:
            model_path(ALIGNER_MODEL)

    def _recognize(self, path: Path, language: str | None):
        model = self._ensure_model()
        kwargs = {"verbose": False}
        if self.name == "nemotron-mlx":
            locales = {
                "de": "de-DE",
                "en": "en-US",
                "fr": "fr-FR",
                "es": "es-ES",
                "pt": "pt-PT",
                "it": "it-IT",
                "ja": "ja-JP",
                "ru": "ru-RU",
                "ko": "ko-KR",
                "zh": "zh-CN",
                "nl": "nl-NL",
            }
            kwargs["language"] = locales.get(language, language or "auto")
        elif self.name == "qwen3-mlx":
            kwargs.update(
                language=alignment_language(language) if language else None,
                hotwords=self.hotwords,
                max_tokens=4096,
            )
        else:
            kwargs.update(hotwords=self.hotwords, max_tokens=4096)
        result = model.generate(str(path), **kwargs)
        if (
            self.name in ("qwen3-mlx", "moss-mlx")
            and getattr(result, "generation_tokens", 0) >= 4096
        ):
            raise RuntimeError(
                "Das Modell hat sein Textlimit erreicht. Der Audioabschnitt wurde nicht "
                "vollständig transkribiert; bitte eine kürzere Aufnahme oder ein anderes Modell verwenden."
            )
        return result

    def transcribe(
        self, audio_path: Path, *, language: str | None = None, progress: ProgressCb | None = None
    ) -> TranscriptResult:
        import numpy as np
        import soundfile as sf

        if self.name not in ("qwen3-mlx", "nemotron-mlx"):
            alignment_language(language)
        self._ensure_model()
        result = TranscriptResult(language=language, model=f"{self.name}:{self.model_id}")
        with (
            sf.SoundFile(str(audio_path)) as source,
            tempfile.TemporaryDirectory(prefix="tarscribe-asr-") as temp,
        ):
            duration = len(source) / source.samplerate
            offset = 0.0
            index = 0
            while offset < duration:
                if progress:
                    progress(0.03 + 0.94 * offset / max(duration, 1), "Transkribiere lokal…")
                source.seek(round(offset * source.samplerate))
                audio = source.read(
                    round(self.chunk_seconds * source.samplerate), dtype="float32", always_2d=True
                ).mean(axis=1)
                if source.samplerate != 16000:
                    from scipy.signal import resample_poly

                    divisor = math.gcd(source.samplerate, 16000)
                    audio = resample_poly(audio, 16000 // divisor, source.samplerate // divisor)
                block_duration = len(audio) / 16000
                if not len(audio):
                    break
                if offset + block_duration < duration - 0.01 and len(audio) > 160000:
                    tail = audio[-48000:]
                    energy = np.mean(tail[: len(tail) // 320 * 320].reshape(-1, 320) ** 2, axis=1)
                    cut = len(audio) - len(tail) + int(np.argmin(energy)) * 320 + 160
                    audio = audio[:cut]
                    block_duration = len(audio) / 16000
                block_path = Path(temp) / "window.wav"
                sf.write(str(block_path), audio, 16000)
                if np.max(np.abs(audio)) < 1e-5:
                    offset += block_duration
                    continue
                raw = self._recognize(block_path, language)
                if self.name == "nemotron-mlx":
                    from .parakeet_mlx_backend import _extract_words

                    words = _extract_words(raw)
                    for word in words:
                        word.start = min(block_duration, max(0.0, word.start))
                        word.end = min(block_duration, max(word.start, word.end))
                else:
                    detected = normalized_language(getattr(raw, "language", None), language)
                    if self.name == "qwen3-mlx":
                        result.language = language or detected
                        spans = [
                            {"text": raw.text, "start": 0, "end": block_duration, "speaker": None}
                        ]
                    elif self.name == "vibevoice-mlx":
                        blocks = parse_streaming_speakers(raw.text)
                        text = " ".join(content for _, content in blocks)
                        words = self._align(audio, text, language, block_duration)
                        cursor = 0

                        def normalized(value):
                            return re.sub(r"\W+", "", value).casefold()

                        for speaker, content in blocks:
                            length = len(normalized(content))
                            count = 0
                            assigned = []
                            while cursor < len(words) and count < length:
                                word = words[cursor]
                                assigned.append(word)
                                count += len(normalized(word.text))
                                cursor += 1
                            if speaker is not None and assigned:
                                result.speakers.append(
                                    SpeakerSpan(
                                        start=offset + assigned[0].start,
                                        end=offset + assigned[-1].end,
                                        speaker=f"ASR_{index:04d}_{speaker}",
                                    )
                                )
                        spans = []
                    else:
                        spans = speaker_segments(raw.segments, block_duration)
                    if self.name != "vibevoice-mlx":
                        words = []
                    for span in spans:
                        if span["end"] <= span["start"]:
                            continue
                        piece = audio[round(span["start"] * 16000) : round(span["end"] * 16000)]
                        aligned = self._align(
                            piece, span["text"], language or detected, len(piece) / 16000
                        )
                        for word in aligned:
                            word.start += span["start"]
                            word.end += span["start"]
                        words.extend(aligned)
                        if span["speaker"] is not None:
                            result.speakers.append(
                                SpeakerSpan(
                                    start=offset + span["start"],
                                    end=offset + span["end"],
                                    speaker=f"ASR_{index:04d}_{span['speaker']}",
                                )
                            )
                for word in words:
                    word.start += offset
                    word.end += offset
                result.words.extend(words)
                offset += block_duration
                index += 1
        if progress:
            progress(1.0, "Transkription abgeschlossen")
        return result

from __future__ import annotations

from collections import deque
import re

from .mlx_audio_backend import parse_streaming_speakers


class NemotronStream:
    def __init__(self, model, language: str | None):
        from mlx_audio.stt.models.nemotron_asr.audio import StreamingLogMelSpectrogram
        from mlx_audio.stt.models.nemotron_asr.streaming import ConformerStreamingState

        self.model = model
        self.language = {
            "de": "de-DE",
            "en": "en-US",
            "fr": "fr-FR",
            "es": "es-ES",
            "it": "it-IT",
            "pt": "pt-PT",
        }.get(language, language or "auto")
        self.mel = StreamingLogMelSpectrogram(model.preprocessor_config)
        self.encoder = ConformerStreamingState(model.encoder, att_context_size=[56, 3])
        self.pending = deque()
        self.decoder = model._decode_prompted_chunks(self._chunks())
        self.words = []
        self.sample_rate = model.preprocessor_config.sample_rate
        self.duration = 0.0

    def _chunks(self):
        while True:
            yield self.pending.popleft()

    def push(self, samples, *, final=False):
        import mlx.core as mx
        from .parakeet_mlx_backend import _extract_words

        self.duration += len(samples) / self.sample_rate
        mel = self.mel.push(mx.array(samples), final=final)
        for encoded in self.encoder.push(mel, final=final):
            prompted = self.model.apply_prompt(encoded, self.language)
            self.encoder.materialize(prompted)
            self.pending.append(prompted)
            self.words = _extract_words(next(self.decoder))
        return [
            {
                "start": min(self.duration, max(0.0, w.start)),
                "end": min(self.duration, max(w.start, w.end)),
                "text": w.text,
                "confidence": None,
                "speaker_id": None,
                "is_final": final or w.end < self.duration - 1.0,
            }
            for w in self.words
        ]


class VibeVoiceStream:
    def __init__(self, model, hotwords: list[str]):
        import numpy as np

        self.model = model
        self.state = model.init_streaming_state(context_info=", ".join(hotwords), max_kv_size=8192)
        self.sample_rate = model.sample_rate
        self.buffer = np.empty(0, dtype="float32")
        self.processed = 0
        self.duration = 0.0
        self.entries = []
        self.speaker = None

    def push(self, samples, *, final=False):
        import mlx.core as mx
        import numpy as np

        self.buffer = np.concatenate([self.buffer, samples])
        self.duration += len(samples) / self.sample_rate
        window_size = self.model.streaming_window_samples
        advance = self.model.streaming_chunk_samples
        while len(self.buffer) >= window_size or (final and len(self.buffer)):
            window = self.buffer[:window_size]
            if len(window) < window_size:
                window = np.pad(window, (0, window_size - len(window)))
            features = self.model.encode_speech(mx.array(window)[None, :])
            text, self.state = self.model.streaming_generate_step(features, self.state)
            blocks = parse_streaming_speakers(text)
            content = re.sub(r"(?:^|\n)\s*Speaker\s+\d+\s*:", " ", text)
            speakers = set()
            for speaker, _ in blocks:
                if speaker is not None:
                    self.speaker = "asr-speaker-" + speaker
                if self.speaker:
                    speakers.add(self.speaker)
            if content.strip():
                self.entries.append(
                    {
                        "start": self.processed / self.sample_rate,
                        "end": min(self.duration, (self.processed + advance) / self.sample_rate),
                        "text": content,
                        "confidence": None,
                        "is_final": False,
                        "speaker_id": next(iter(speakers)) if len(speakers) == 1 else None,
                        "speaker_source": "asr",
                    }
                )
            self.processed += advance
            self.buffer = self.buffer[advance:]
        return list(self.entries)


class NativeSession:
    def __init__(self, backend, sample_rate: int, channels: int, language: str | None):
        import soxr

        model = backend._ensure_model()
        self.stream = (
            NemotronStream(model, language)
            if backend.name == "nemotron-mlx"
            else VibeVoiceStream(model, backend.hotwords)
        )
        self.sample_rate = sample_rate
        self.channels = channels
        self.read_samples = 0
        self.resampler = soxr.ResampleStream(
            sample_rate, self.stream.sample_rate, 1, dtype="float32"
        )
        self.words = []

    def read(self, path, duration: float):
        import numpy as np

        total = min(int(duration * self.sample_rate), path.stat().st_size // (2 * self.channels))
        with path.open("rb") as source:
            source.seek(self.read_samples * 2 * self.channels)
            while self.read_samples < total:
                count = min(self.sample_rate * 5, total - self.read_samples)
                data = source.read(count * 2 * self.channels)
                if not data:
                    break
                samples = np.frombuffer(data, dtype="<i2").reshape(-1, self.channels)
                mono = samples.astype("float32").mean(axis=1) / 32768
                self.read_samples += len(mono)
                resampled = self.resampler.resample_chunk(mono)
                self.words = self.stream.push(resampled)
        return [dict(word) for word in self.words]

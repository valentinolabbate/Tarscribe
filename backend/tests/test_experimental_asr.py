from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from tarscribe_backend.asr_catalog import EXPERIMENTAL_ASR, alignment_language
from tarscribe_backend.ml.asr.base import WordSeg
from tarscribe_backend.ml.asr.factory import build_backend
from tarscribe_backend.ml.asr.mlx_audio_backend import (
    MlxAudioBackend,
    aligned_words,
    normalized_language,
    parse_streaming_speakers,
    speaker_segments,
)
from tarscribe_backend.performance_profiles import resolve_asr_selection


@pytest.mark.parametrize("engine", EXPERIMENTAL_ASR)
def test_selection_and_lazy_factory(engine):
    selection = resolve_asr_selection(
        {"asr_override": engine, "asr_hotwords": ["Tarscribe"]},
        SimpleNamespace(is_apple_silicon=True),
    )
    backend = build_backend(selection=selection)
    assert backend.name == engine
    assert backend.model_id == EXPERIMENTAL_ASR[engine]["model"]
    assert backend.hotwords == ["Tarscribe"]
    assert backend._model is None


def test_unknown_factory_engine_is_not_silently_whisper():
    with pytest.raises(ValueError, match="Unbekannte"):
        build_backend(selection={"engine": "unsupported"})


@pytest.mark.parametrize("value", ["de", "de-DE", "German", "german"])
def test_alignment_language_aliases(value):
    assert alignment_language(value) == "German"


def test_missing_alignment_language_requires_explicit_choice():
    with pytest.raises(ValueError, match="Einstellungen"):
        alignment_language(None)
    assert normalized_language(["German"], None) == "de"


def test_alignment_rejects_nan_and_preserves_punctuation():
    words = aligned_words([SimpleNamespace(text="Hallo,", start_time=0.2, end_time=1.2)], 1)
    assert words == [WordSeg(start=0.2, end=1, text=" Hallo,")]
    with pytest.raises(RuntimeError, match="ungültige"):
        aligned_words([SimpleNamespace(text="Welt", start_time=math.nan, end_time=1)], 2)


def test_moss_labels_are_metadata_not_spoken_words():
    spans = speaker_segments(
        [{"start": 0, "end": 2, "text": "[S01] Hallo Welt", "speaker_id": "S01"}], 1.5
    )
    assert spans == [{"text": "Hallo Welt", "speaker": "S01", "start": 0, "end": 1.5}]


def test_vibevoice_speaker_tags_and_continuations():
    assert parse_streaming_speakers(" \n Speaker 0:Hallo\n Speaker 1:Welt") == [
        ("0", "Hallo"),
        ("1", "Welt"),
    ]
    assert parse_streaming_speakers("Fortsetzung") == [(None, "Fortsetzung")]


def test_batch_chunk_offsets_and_speaker_scope(tmp_path, monkeypatch):
    wav = tmp_path / "synthetic.wav"
    sf.write(str(wav), np.ones(16000 * 21, dtype="float32") * 0.1, 16000)
    backend = MlxAudioBackend("moss-mlx", chunk_seconds=10)
    backend._model = object()
    monkeypatch.setattr(
        backend,
        "_recognize",
        lambda *_: SimpleNamespace(
            segments=[{"start": 0, "end": 1, "text": "[S01] Test", "speaker_id": "S01"}],
            language="de",
        ),
    )
    monkeypatch.setattr(backend, "_align", lambda *_: [WordSeg(start=0, end=0.5, text=" Test")])
    result = backend.transcribe(wav, language="de")
    assert [word.start for word in result.words] == [0, 10, 20]
    assert len({span.speaker for span in result.speakers}) == 3
    assert result.language == "de"


def test_silence_is_not_sent_to_generative_models(tmp_path, monkeypatch):
    wav = tmp_path / "silence.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)
    backend = MlxAudioBackend("qwen3-mlx")
    backend._model = object()
    monkeypatch.setattr(backend, "_recognize", lambda *_: pytest.fail("Silence must be skipped"))
    assert backend.transcribe(wav).words == []


def test_cancellation_callback_propagates(tmp_path):
    wav = tmp_path / "silence.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)
    backend = MlxAudioBackend("qwen3-mlx")
    backend._model = object()

    def cancel(*_):
        raise RuntimeError("canceled")

    with pytest.raises(RuntimeError, match="canceled"):
        backend.transcribe(wav, progress=cancel)


def test_live_native_path_does_not_build_rolling_window(monkeypatch):
    from tarscribe_backend.ml import live_asr

    class Native:
        def transcribe_live(self, *args):
            return [{"start": 0, "end": 1, "text": " Test", "is_final": False}]

    monkeypatch.setattr(live_asr, "get_backend", lambda **_: Native())
    monkeypatch.setattr(live_asr, "build_wav_window", lambda *_: pytest.fail("No rolling window"))
    words = live_asr.analyze_window(Path("unused"), "session", 1, [], 16000, 1)
    assert words[0]["id"] == "live-session-0"


def test_live_selection_does_not_reuse_batch_model_id(monkeypatch):
    from tarscribe_backend.ml.asr import factory

    prefs = {
        "asr_override": "qwen3-mlx",
        "asr_model": "custom/qwen",
        "live_asr_override": "nemotron-mlx",
    }
    monkeypatch.setattr(factory, "load_prefs", lambda: prefs)
    monkeypatch.setattr(factory, "detect_hardware", lambda: SimpleNamespace(is_apple_silicon=True))
    factory.unload_backend()
    try:
        assert factory.get_backend(live=True).model_id == EXPERIMENTAL_ASR["nemotron-mlx"]["model"]
        assert factory.get_backend().model_id == "custom/qwen"
    finally:
        factory.unload_backend()


def test_bitnet_plain_output_is_accepted_and_not_logged(tmp_path, monkeypatch):
    from tarscribe_backend.ml.asr import bitnet_backend

    wav = tmp_path / "synthetic.wav"
    sf.write(str(wav), np.zeros(16000), 16000)
    backend = bitnet_backend.BitNetBackend()
    monkeypatch.setattr(backend, "_ensure_model", lambda: tmp_path)
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout="---READY---\nHallo Welt\n---END---\n")

    monkeypatch.setattr(bitnet_backend.subprocess, "run", run)
    result = backend._recognize(wav, "de")
    assert result.segments[0]["text"] == "Hallo Welt"
    assert calls[0][1]["capture_output"] is True
    assert "shell" not in calls[0][1]
    assert calls[0][1]["timeout"] == 600


def test_native_session_reads_only_new_pcm_and_resamples(tmp_path, monkeypatch):
    pytest.importorskip("soxr")
    from tarscribe_backend.ml.asr import native_streaming

    pushes = []

    class Stream:
        sample_rate = 16000

        def __init__(self, *_args):
            pass

        def push(self, samples):
            pushes.append(samples.copy())
            return [{"text": " Test"}]

    monkeypatch.setattr(native_streaming, "NemotronStream", Stream)
    backend = SimpleNamespace(name="nemotron-mlx", _ensure_model=lambda: None)
    session = native_streaming.NativeSession(backend, 48000, 2, "de")
    pcm = tmp_path / "synthetic.pcm"
    pcm.write_bytes(np.ones((48000 * 2, 2), dtype="<i2").tobytes())
    session.read(pcm, 1)
    count = len(pushes)
    assert session.read_samples == 48000
    session.read(pcm, 1)
    assert len(pushes) == count
    session.read(pcm, 2)
    assert session.read_samples == 96000
    assert 30000 < sum(len(samples) for samples in pushes) <= 32000


def test_settings_can_reset_language_without_resetting_other_fields(monkeypatch):
    from tarscribe_backend.routers import settings

    patches = []
    monkeypatch.setattr(
        settings.settings_store, "save_prefs", lambda patch: patches.append(patch) or patch
    )
    monkeypatch.setattr(settings.settings_store, "has_hf_token", lambda: False)
    monkeypatch.setattr(settings.settings_store, "has_caldav_password", lambda: False)
    monkeypatch.setattr(settings.settings_store, "secret_storage_status", lambda: {})
    settings.update_settings(settings.PrefsIn(language=None))
    assert patches == [{"language": None}]


@pytest.mark.parametrize("hotwords", [["x"] * 101, ["x" * 201], [""]])
def test_hotwords_are_bounded(hotwords):
    from pydantic import ValidationError
    from tarscribe_backend.routers.settings import PrefsIn

    with pytest.raises(ValidationError):
        PrefsIn(asr_hotwords=hotwords)


def test_nemotron_chunk_iterator_does_not_compare_arrays_to_sentinel():
    from collections import deque
    from tarscribe_backend.ml.asr.native_streaming import NemotronStream

    class Array:
        def __eq__(self, other):
            raise TypeError("Arrays cannot be compared with None")

    chunk = Array()
    stream = object.__new__(NemotronStream)
    stream.pending = deque([chunk])
    chunks = stream._chunks()
    assert next(chunks) is chunk
    stream.pending.append(chunk)
    assert next(chunks) is chunk


def test_bundled_bitnet_runtime_takes_precedence_over_local_cache(tmp_path, monkeypatch):
    from tarscribe_backend.ml.asr import bitnet_backend

    module = tmp_path / "resources/backend/tarscribe_backend/ml/asr/bitnet_backend.py"
    runtime = tmp_path / "resources/vibeasr/asr_stream_server"
    runtime.parent.mkdir(parents=True)
    runtime.touch()
    monkeypatch.setattr(bitnet_backend, "__file__", str(module))
    monkeypatch.delenv("TARSCRIBE_BITNET_BINARY", raising=False)
    assert bitnet_backend.bitnet_binary() == runtime
    monkeypatch.setenv("TARSCRIBE_BITNET_BINARY", str(tmp_path / "custom"))
    assert bitnet_backend.bitnet_binary() == tmp_path / "custom"


def test_prepare_downloads_aligner_without_loading_it(monkeypatch):
    from tarscribe_backend.ml.asr import mlx_audio_backend
    from tarscribe_backend.asr_catalog import ALIGNER_MODEL

    backend = MlxAudioBackend("moss-mlx")
    backend._model = object()
    downloads = []
    monkeypatch.setattr(mlx_audio_backend, "model_path", downloads.append)
    backend.prepare()
    assert downloads == [ALIGNER_MODEL]
    assert backend._aligner is None

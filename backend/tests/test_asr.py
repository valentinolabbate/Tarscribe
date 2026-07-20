"""ASR robustness tests — timestamp coercion, empty handling, VAD fallback, duration.

These exercise the pure/stub-able parts of the backends without loading the
multi-GB ASR models (faster-whisper / parakeet-mlx / mlx-whisper are not installed in CI).
"""

from __future__ import annotations

import types
from pathlib import Path

import pytest


# ── parakeet-mlx token flattening ────────────────────────────────────────────

def _tok(text, start, end):
    return types.SimpleNamespace(text=text, start=start, end=end)


def test_parakeet_extract_words_coerces_none_and_skips_empty():
    from tarscribe_backend.ml.asr.parakeet_mlx_backend import _extract_words

    sentence = types.SimpleNamespace(
        tokens=[
            _tok("Hallo", 0.0, 0.5),
            _tok("", 0.5, 0.6),          # empty token → dropped
            _tok(" Welt", None, None),    # None timestamps → coerced to prev end
        ]
    )
    result = types.SimpleNamespace(sentences=[sentence])
    words = _extract_words(result)

    assert [w.text for w in words] == ["Hallo", " Welt"]
    # None start/end coerced to the previous end (0.5), monotonic, all floats.
    assert words[1].start == 0.5 and words[1].end == 0.5
    assert all(isinstance(w.start, float) and isinstance(w.end, float) for w in words)


def test_parakeet_offline_ref_returns_local_dir_as_is(tmp_path):
    from tarscribe_backend.ml.asr.parakeet_mlx_backend import _offline_ref

    assert _offline_ref(str(tmp_path)) == str(tmp_path)


def test_parakeet_offline_ref_falls_back_to_id_when_not_cached():
    from tarscribe_backend.ml.asr.parakeet_mlx_backend import _offline_ref

    # Not a local dir and not in the HF cache (or huggingface_hub absent in CI):
    # must hand back the bare id so a first-run download can still happen.
    assert _offline_ref("definitely-not/cached-model-xyz") == "definitely-not/cached-model-xyz"


def test_faster_whisper_loads_offline_first_then_downloads(monkeypatch):
    import sys

    calls: list[bool] = []

    class _FakeWhisperModel:
        def __init__(self, _size, *, local_files_only, **_kw):
            calls.append(local_files_only)
            if local_files_only:
                raise RuntimeError("model not found in cache")

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = _FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)

    from tarscribe_backend.ml.asr.faster_whisper_backend import FasterWhisperBackend

    FasterWhisperBackend()._ensure_model()
    assert calls == [True, False]  # offline attempt first, then download fallback


def test_faster_whisper_offline_hit_skips_download(monkeypatch):
    import sys

    calls: list[bool] = []

    class _FakeWhisperModel:
        def __init__(self, _size, *, local_files_only, **_kw):
            calls.append(local_files_only)  # offline succeeds, no exception

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = _FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)

    from tarscribe_backend.ml.asr.faster_whisper_backend import FasterWhisperBackend

    FasterWhisperBackend()._ensure_model()
    assert calls == [True]  # cached → no online fallback


def test_parakeet_extract_words_falls_back_to_sentence_without_tokens():
    from tarscribe_backend.ml.asr.parakeet_mlx_backend import _extract_words

    sentence = types.SimpleNamespace(tokens=None, text="Ganzer Satz", start=1.0, end=2.0)
    result = types.SimpleNamespace(sentences=[sentence])
    words = _extract_words(result)
    assert len(words) == 1
    assert words[0].text == "Ganzer Satz"
    assert words[0].start == 1.0 and words[0].end == 2.0


# ── mlx-whisper dict/object extraction ──────────────────────────────────────

def test_mlx_whisper_extract_words_from_dict_segments():
    from tarscribe_backend.ml.asr.mlx_whisper_backend import _extract_words

    result = {
        "segments": [
            {
                "words": [
                    {"word": "Hallo", "start": 0.0, "end": 0.4, "probability": 0.95},
                    {"word": " ", "start": 0.4, "end": 0.4},
                    {"word": " Welt", "start": None, "end": None, "score": 0.8},
                ]
            }
        ]
    }

    words = _extract_words(result)

    assert [w.text for w in words] == ["Hallo", " Welt"]
    assert words[0].confidence == 0.95
    assert words[1].confidence == 0.8
    assert words[1].start == 0.4 and words[1].end == 0.4


def test_mlx_whisper_extract_words_falls_back_to_segment_text():
    from tarscribe_backend.ml.asr.mlx_whisper_backend import _extract_words

    result = types.SimpleNamespace(
        segments=[types.SimpleNamespace(words=None, text="Ganzer Satz", start=1.0, end=2.5)]
    )

    words = _extract_words(result)

    assert len(words) == 1
    assert words[0].text == "Ganzer Satz"
    assert words[0].start == 1.0 and words[0].end == 2.5


def test_factory_builds_mlx_whisper_backend_without_heavy_import():
    from tarscribe_backend.ml.asr.factory import build_backend
    from tarscribe_backend.ml.asr.mlx_whisper_backend import MlxWhisperBackend

    backend = build_backend(
        selection={"engine": "mlx-whisper", "model_id": "mlx-community/whisper-large-v3-mlx"}
    )

    assert isinstance(backend, MlxWhisperBackend)
    assert backend.model_id == "mlx-community/whisper-large-v3-mlx"


# ── faster-whisper segment collection + VAD fallback ─────────────────────────

def _seg(words, *, start=0.0, end=1.0, text=""):
    return types.SimpleNamespace(words=words, start=start, end=end, text=text)


def _word(word, start, end, prob=0.9):
    return types.SimpleNamespace(word=word, start=start, end=end, probability=prob)


class _StubModel:
    """Stands in for faster_whisper.WhisperModel.transcribe."""

    def __init__(self, by_vad):
        self.by_vad = by_vad  # {True: (segments, info), False: (...)}
        self.calls: list[bool] = []

    def transcribe(self, _path, *, language=None, word_timestamps=True, vad_filter=True):
        self.calls.append(vad_filter)
        return self.by_vad[vad_filter]


def _make_fw_backend(stub):
    from tarscribe_backend.ml.asr.faster_whisper_backend import FasterWhisperBackend

    backend = FasterWhisperBackend()
    backend._model = stub  # skip the heavy real model load
    return backend


def test_faster_whisper_collect_coerces_none_timestamps_and_skips_empty():
    info = types.SimpleNamespace(duration=2.0, language="de")
    segs = [
        _seg([_word("Hallo", 0.0, 0.5), _word("  ", 0.5, 0.5), _word(" Welt", None, None)]),
    ]
    stub = _StubModel({True: (segs, info)})
    backend = _make_fw_backend(stub)

    result = backend.transcribe(Path("x.wav"))
    assert [w.text for w in result.words] == ["Hallo", " Welt"]
    assert result.words[1].start == 0.5 and result.words[1].end == 0.5
    assert result.language == "de"
    assert stub.calls == [True]  # VAD pass produced words → no retry


def test_faster_whisper_retries_without_vad_when_first_pass_empty():
    info = types.SimpleNamespace(duration=2.0, language="de")
    empty = ([], info)
    full = ([_seg([_word("Test", 0.0, 1.0)])], info)
    stub = _StubModel({True: empty, False: full})
    backend = _make_fw_backend(stub)

    result = backend.transcribe(Path("x.wav"))
    assert [w.text for w in result.words] == ["Test"]
    assert stub.calls == [True, False]  # retried once without the VAD filter


# ── hf_offline context manager (forces cache-only model loads) ───────────────

def _install_fake_hf(monkeypatch, initial=False):
    import sys

    constants = types.ModuleType("huggingface_hub.constants")
    constants.HF_HUB_OFFLINE = initial
    parent = types.ModuleType("huggingface_hub")
    parent.constants = constants
    monkeypatch.setitem(sys.modules, "huggingface_hub", parent)
    monkeypatch.setitem(sys.modules, "huggingface_hub.constants", constants)
    return constants


def test_hf_offline_flips_and_restores_constant(monkeypatch):
    constants = _install_fake_hf(monkeypatch, initial=False)
    from tarscribe_backend.ml.lifecycle import hf_offline

    assert constants.HF_HUB_OFFLINE is False
    with hf_offline():
        assert constants.HF_HUB_OFFLINE is True
    assert constants.HF_HUB_OFFLINE is False


def test_hf_offline_restores_on_exception(monkeypatch):
    constants = _install_fake_hf(monkeypatch, initial=False)
    from tarscribe_backend.ml.lifecycle import hf_offline

    with pytest.raises(RuntimeError):
        with hf_offline():
            assert constants.HF_HUB_OFFLINE is True
            raise RuntimeError("load failed")
    assert constants.HF_HUB_OFFLINE is False  # restored despite the error


# ── duration probing falls back to soundfile ─────────────────────────────────

def test_probe_duration_reads_wav_header_via_soundfile(tmp_path):
    import numpy as np
    import soundfile as sf

    from tarscribe_backend import audio

    wav = tmp_path / "tone.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)  # 1.0 s

    assert audio._soundfile_duration(wav) == pytest.approx(1.0, abs=0.01)
    # Public entry point returns the same whether ffprobe is present or not.
    assert audio.probe_duration(wav) == pytest.approx(1.0, abs=0.05)


# ── _run_asr failure paths (no model needed; backend is stubbed) ─────────────

@pytest.fixture()
def jobs_env(monkeypatch, tmp_path):
    import importlib

    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.jobs as jobs

    importlib.reload(jobs)
    return db, jobs


def _seed_asr_job(db, audio_path: str):
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, Topic

    with db.session_scope() as s:
        topic = Topic(name="T")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Audio", audio_path=audio_path)
        s.add(rec)
        s.flush()
        job = Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.pending)
        s.add(job)
        s.flush()
        return rec.id, job.id


def test_run_asr_marks_failed_when_no_speech(jobs_env, tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf

    from tarscribe_backend.ml.asr import factory
    from tarscribe_backend.ml.asr.base import TranscriptResult
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    db, jobs = jobs_env
    wav = tmp_path / "silent.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)
    rec_id, job_id = _seed_asr_job(db, str(wav))

    class _Empty:
        name = "stub"

        def transcribe(self, *_a, **_k):
            return TranscriptResult(language=None, words=[])

    monkeypatch.setattr(factory, "get_backend", lambda *_a, **_k: _Empty())

    jobs._run_asr(rec_id, job_id, None)

    with db.session_scope() as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert "Keine Sprache" in (s.get(Job, job_id).error or "")
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def test_run_asr_failure_keeps_existing_transcript_ready(jobs_env, tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf

    from tarscribe_backend.ml.asr import factory
    from tarscribe_backend.ml.asr.base import TranscriptResult
    from tarscribe_backend.models import (
        Job,
        JobStatus,
        Recording,
        RecordingStatus,
        Transcript,
        Word,
    )

    db, jobs = jobs_env
    wav = tmp_path / "silent-with-existing.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)
    rec_id, job_id = _seed_asr_job(db, str(wav))
    with db.session_scope() as s:
        transcript = Transcript(recording_id=rec_id, asr_model="live")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Alt"))

    class _Empty:
        name = "stub"

        def transcribe(self, *_a, **_k):
            return TranscriptResult(language=None, words=[])

    monkeypatch.setattr(factory, "get_backend", lambda *_a, **_k: _Empty())

    jobs._run_asr(rec_id, job_id, None)

    with db.session_scope() as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert s.get(Recording, rec_id).status == RecordingStatus.ready


def test_run_asr_marks_failed_when_audio_missing(jobs_env):
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    db, jobs = jobs_env
    rec_id, job_id = _seed_asr_job(db, "/nonexistent/missing.wav")

    jobs._run_asr(rec_id, job_id, None)

    with db.session_scope() as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert "Audiodatei nicht gefunden" in (s.get(Job, job_id).error or "")
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def test_run_asr_queues_diarization_before_automatic_action_extraction(
    jobs_env, tmp_path, monkeypatch
):
    import numpy as np
    import soundfile as sf

    from tarscribe_backend.ml.asr import factory
    from tarscribe_backend.ml.asr.base import TranscriptResult, WordSeg
    from tarscribe_backend.models import Job, JobStatus

    db, jobs = jobs_env
    wav = tmp_path / "speech.wav"
    sf.write(str(wav), np.zeros(16000, dtype="float32"), 16000)
    rec_id, job_id = _seed_asr_job(db, str(wav))

    class _Result:
        name = "stub"

        def transcribe(self, *_args, **_kwargs):
            return TranscriptResult(
                language="de",
                model="stub",
                words=[WordSeg(start=0, end=0.5, text=" Hallo", confidence=0.9)],
            )

    queued: list[int] = []
    monkeypatch.setattr(factory, "get_backend", lambda *_args: _Result())
    monkeypatch.setattr(jobs, "enqueue_diarization", lambda recording_id: queued.append(recording_id))
    monkeypatch.setattr(jobs, "schedule_reindex", lambda _recording_id: None)
    monkeypatch.setattr(
        jobs,
        "maybe_enqueue_action_items",
        lambda _recording_id: pytest.fail("Action extraction must wait for diarization"),
    )

    jobs._run_asr(rec_id, job_id, None)

    with db.session_scope() as session:
        assert session.get(Job, job_id).status == JobStatus.done
    assert queued == [rec_id]


def test_successful_diarization_and_matching_then_start_action_extraction(
    jobs_env, monkeypatch
):
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, Topic, Transcript
    import tarscribe_backend.ml.diarization as diarization
    import tarscribe_backend.ml.speaker_matching as speaker_matching
    import tarscribe_backend.performance_profiles as performance_profiles
    import tarscribe_backend.settings_store as settings_store

    db, jobs = jobs_env
    with db.session_scope() as session:
        topic = Topic(name="T")
        session.add(topic)
        session.flush()
        recording = Recording(topic_id=topic.id, title="Aufnahme", audio_path="/tmp/audio.wav")
        session.add(recording)
        session.flush()
        session.add(Transcript(recording_id=recording.id, asr_model="test"))
        job = Job(recording_id=recording.id, phase=JobPhase.diarization, status=JobStatus.pending)
        session.add(job)
        session.flush()
        recording_id, job_id = recording.id, job.id

    class _Backend:
        def __init__(self, **_kwargs):
            pass

        def diarize(self, *_args, **_kwargs):
            return [types.SimpleNamespace(start=0.0, end=1.0, speaker="SPEAKER_00")]

    matched: list[int] = []
    extracted: list[int] = []
    monkeypatch.setattr(settings_store, "get_hf_token", lambda: "test-token")
    monkeypatch.setattr(settings_store, "load_prefs", lambda: {"speaker_match_threshold": 0.5})
    monkeypatch.setattr(
        performance_profiles,
        "resolve_diarization_selection",
        lambda *_args: {"model_id": "test", "device": "cpu"},
    )
    monkeypatch.setattr(diarization, "DiarizationBackend", _Backend)
    monkeypatch.setattr(
        speaker_matching,
        "match_recording",
        lambda _session, recording_id, _threshold: matched.append(recording_id) or [],
    )
    monkeypatch.setattr(speaker_matching, "apply_matches", lambda *_args: None)
    monkeypatch.setattr(jobs, "schedule_reindex", lambda _recording_id: None)
    monkeypatch.setattr(
        jobs, "maybe_enqueue_action_items", lambda recording_id: extracted.append(recording_id)
    )

    jobs._run_diarization(recording_id, job_id, {})

    with db.session_scope() as session:
        assert session.get(Job, job_id).status == JobStatus.done
    assert matched == [recording_id]
    assert extracted == [recording_id]

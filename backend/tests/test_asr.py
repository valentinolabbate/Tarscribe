"""ASR robustness tests — timestamp coercion, empty handling, VAD fallback, duration.

These exercise the pure/stub-able parts of the backends without loading the
multi-GB ASR models (faster-whisper / parakeet-mlx are not installed in CI).
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


def test_parakeet_extract_words_falls_back_to_sentence_without_tokens():
    from tarscribe_backend.ml.asr.parakeet_mlx_backend import _extract_words

    sentence = types.SimpleNamespace(tokens=None, text="Ganzer Satz", start=1.0, end=2.0)
    result = types.SimpleNamespace(sentences=[sentence])
    words = _extract_words(result)
    assert len(words) == 1
    assert words[0].text == "Ganzer Satz"
    assert words[0].start == 1.0 and words[0].end == 2.0


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


def test_run_asr_marks_failed_when_audio_missing(jobs_env):
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    db, jobs = jobs_env
    rec_id, job_id = _seed_asr_job(db, "/nonexistent/missing.wav")

    jobs._run_asr(rec_id, job_id, None)

    with db.session_scope() as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert "Audiodatei nicht gefunden" in (s.get(Job, job_id).error or "")
        assert s.get(Recording, rec_id).status == RecordingStatus.failed

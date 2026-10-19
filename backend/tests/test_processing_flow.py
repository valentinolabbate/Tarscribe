from __future__ import annotations

import hashlib
import importlib
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from sqlmodel import select


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tempfile.mkdtemp(prefix="tarscribe-processing-test-"))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")
    import tarscribe_backend.config as config
    importlib.reload(config)
    config.get_settings.cache_clear()
    import tarscribe_backend.db as db
    importlib.reload(db)
    db.init_db()
    import tarscribe_backend.settings_store as prefs
    monkeypatch.setattr(prefs, "get_settings", config.get_settings)
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.ml.lifecycle as lifecycle
    monkeypatch.setattr(lifecycle, "unload_all", lambda: None)
    monkeypatch.setattr(jobs, "schedule_reindex", lambda *_: None)
    submitted = []
    monkeypatch.setattr(jobs._executor, "submit", lambda *args: submitted.append(args))
    monkeypatch.setattr(jobs, "_submit_llm_job", lambda *args: submitted.append(args))
    import tarscribe_backend.main as main
    importlib.reload(main)
    from tarscribe_backend.models import Recording, Topic
    wav = config.get_settings().audio_dir / "original.wav"
    sf.write(wav, np.arange(64000, dtype="int16"), 16000, subtype="PCM_16")
    with db.session_scope() as session:
        topic = Topic(name="Processing")
        session.add(topic)
        session.flush()
        rec = Recording(topic_id=topic.id, title="Recording", audio_path=str(wav), duration_sec=4)
        session.add(rec)
        session.flush()
        recording_id = rec.id
    return SimpleNamespace(client=TestClient(main.create_app()), db=db, jobs=jobs, prefs=prefs,
                           recording_id=recording_id, wav=wav, submitted=submitted)


def add_transcript(env):
    from tarscribe_backend.models import Transcript, Word
    with env.db.session_scope() as session:
        transcript = Transcript(recording_id=env.recording_id, asr_model="test")
        session.add(transcript)
        session.flush()
        session.add(Word(transcript_id=transcript.id, idx=0, start=1, end=2, text="Hallo"))


@pytest.mark.parametrize("endpoint", ["diarize", "match", "action-items/extract",
                                       "chapters/generate", "summarize?template_id=1"])
def test_followups_require_transcript(env, endpoint):
    response = env.client.post(f"/api/recordings/{env.recording_id}/{endpoint}")
    assert response.status_code == 409
    assert "Transkription" in response.json()["detail"]
    assert env.submitted == []


@pytest.mark.parametrize("payload", [
    {"start_sec": -1}, {"start_sec": 2, "end_sec": 2}, {"start_sec": 3, "end_sec": 2},
    {"start_sec": 4}, {"start_sec": 0, "end_sec": 5},
    {"start_sec": "NaN"}, {"end_sec": "Infinity"},
])
def test_invalid_audio_range_does_not_queue_work(env, payload):
    response = env.client.post(f"/api/recordings/{env.recording_id}/transcribe", json=payload)
    assert response.status_code == 422
    assert env.submitted == []


def test_trimmed_asr_preserves_original_and_offsets_words_and_speakers(env, monkeypatch):
    from tarscribe_backend.ml.asr import factory
    from tarscribe_backend.ml.asr.base import SpeakerSpan, TranscriptResult, WordSeg
    from tarscribe_backend.models import DiarizationRun, Job, JobStatus, Segment, Transcript, Word
    original = env.wav.read_bytes()
    processed_paths = []

    class Backend:
        def transcribe(self, path, **kwargs):
            processed_paths.append(path)
            samples, rate = sf.read(path, dtype="int16")
            full, _ = sf.read(env.wav, dtype="int16")
            assert rate == 16000
            np.testing.assert_array_equal(samples, full[16000:48000])
            return TranscriptResult(language="de", model="test", words=[WordSeg(0.25, 0.75, "Hallo")],
                                    speakers=[SpeakerSpan(0, 2, "SPEAKER_00")])

    monkeypatch.setattr(factory, "get_backend", lambda *_: Backend())
    response = env.client.post(f"/api/recordings/{env.recording_id}/transcribe",
                               json={"start_sec": 1, "end_sec": 3})
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    assert len(env.submitted) == 1
    env.jobs._run_asr(env.recording_id, job_id, None)
    with env.db.session_scope() as session:
        assert session.get(Job, job_id).status == JobStatus.done
        transcript = session.exec(select(Transcript)).one()
        word = session.exec(select(Word).where(Word.transcript_id == transcript.id)).one()
        assert (word.start, word.end) == (1.25, 1.75)
        run = session.exec(select(DiarizationRun)).one()
        segment = session.exec(select(Segment).where(Segment.run_id == run.id)).one()
        assert (segment.start, segment.end) == (1, 3)
        assert len(session.exec(select(Job)).all()) == 1
    assert hashlib.sha256(env.wav.read_bytes()).digest() == hashlib.sha256(original).digest()
    assert not processed_paths[0].exists()


def test_diarization_uses_same_range_without_matching_or_extraction(env, monkeypatch):
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, Segment
    import tarscribe_backend.ml.diarization as diarization
    import tarscribe_backend.ml.speaker_matching as matching
    import tarscribe_backend.performance_profiles as profiles
    add_transcript(env)
    with env.db.session_scope() as session:
        rec = session.get(Recording, env.recording_id)
        rec.trim_start_sec, rec.trim_end_sec = 1, 3
        session.add(rec)
    monkeypatch.setattr(env.prefs, "get_hf_token", lambda: "test-token")
    monkeypatch.setattr(profiles, "resolve_diarization_selection",
                        lambda *_: {"model_id": "test", "device": "cpu"})
    monkeypatch.setattr(matching, "match_recording", lambda *_: pytest.fail("Automatic matching"))
    monkeypatch.setattr(env.jobs, "enqueue_action_items", lambda *_: pytest.fail("Automatic analysis"))

    class Backend:
        def __init__(self, **kwargs):
            pass

        def diarize(self, path, **kwargs):
            assert sf.info(path).duration == 2
            return [SimpleNamespace(start=0.2, end=1.5, speaker="SPEAKER_00")]

    monkeypatch.setattr(diarization, "DiarizationBackend", Backend)
    response = env.client.post(f"/api/recordings/{env.recording_id}/diarize")
    assert response.status_code == 200
    env.jobs._run_diarization(env.recording_id, response.json()["job_id"], {})
    with env.db.session_scope() as session:
        segment = session.exec(select(Segment)).one()
        assert (segment.start, segment.end) == (1.2, 2.5)
        job = session.exec(select(Job)).one()
        assert job.phase == JobPhase.diarization
        assert job.status == JobStatus.done


def test_analysis_and_summary_do_not_require_diarization(env):
    from tarscribe_backend.models import Job, JobStatus
    add_transcript(env)
    response = env.client.post(f"/api/recordings/{env.recording_id}/action-items/extract")
    assert response.status_code == 200
    assert env.client.post(f"/api/recordings/{env.recording_id}/diarize").status_code == 409
    with env.db.session_scope() as session:
        job = session.get(Job, response.json()["job_id"])
        job.status = JobStatus.done
        session.add(job)
    template = env.client.get("/api/templates").json()[0]
    summary = env.client.post(f"/api/recordings/{env.recording_id}/summarize",
                              params={"template_id": template["id"]})
    assert summary.status_code == 200
    saved = env.client.get(f"/api/summaries/{summary.json()['summary_id']}").json()
    assert saved["template_id"] == template["id"]


def test_matching_requires_speakers_and_runs_only_on_request(env, monkeypatch):
    from tarscribe_backend.models import DiarizationRun, Job, JobPhase, JobStatus
    import tarscribe_backend.ml.speaker_matching as matching
    add_transcript(env)
    assert env.client.post(f"/api/recordings/{env.recording_id}/match?background=true").status_code == 409
    with env.db.session_scope() as session:
        session.add(DiarizationRun(recording_id=env.recording_id, model="test"))
    response = env.client.post(f"/api/recordings/{env.recording_id}/match?background=true")
    assert response.status_code == 200
    calls = []
    monkeypatch.setattr(matching, "match_recording", lambda *_: calls.append("match") or [])
    monkeypatch.setattr(matching, "apply_matches", lambda *_: calls.append("apply"))
    env.jobs._run_speaker_matching(env.recording_id, response.json()["job_id"])
    assert calls == ["match", "apply"]
    with env.db.session_scope() as session:
        job = session.exec(select(Job)).one()
        assert job.phase == JobPhase.speaker_matching
        assert job.status == JobStatus.done


def test_light_mode_blocks_live_model_work_and_preserves_other_preferences(env, monkeypatch):
    import tarscribe_backend.live_analysis as live_analysis
    import tarscribe_backend.ml.live_asr as live_asr
    import tarscribe_backend.ml.live_diarization as live_diarization
    from tarscribe_backend.models import LiveRecordingSession, LiveSessionStatus, Recording
    prefs = env.client.put("/api/settings", json={"light_mode_enabled": True}).json()
    assert prefs["light_mode_enabled"] is True
    assert prefs["live_transcription_enabled"] is True
    assert prefs["live_speaker_detection_enabled"] is True
    monkeypatch.setattr(live_asr, "analyze_window", lambda **_: pytest.fail("Live ASR"))
    monkeypatch.setattr(live_diarization, "run_window", lambda **_: pytest.fail("Live diarization"))
    with env.db.session_scope() as session:
        rec = session.get(Recording, env.recording_id)
        session.add(LiveRecordingSession(id="light", title="Light", status=LiveSessionStatus.recording,
                                         topic_id=rec.topic_id, pcm_path=str(env.wav),
                                         received_duration_sec=4))
    service = live_analysis.LiveAnalysisService()
    monkeypatch.setattr(service._executor, "submit", lambda *_: pytest.fail("Live worker"))
    try:
        service.attach("light")
        service.tick("light")
        service._analyze("light")
        assert service._diarization_tick("light", Path(env.wav), 4, 16000, 1) is None
    finally:
        service._executor.shutdown(wait=True)

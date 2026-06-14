"""End-to-end smoke tests against the FastAPI app using a temp data dir."""

from __future__ import annotations

import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")  # disable auth in tests

    # Import after env is set so cached settings pick up the temp dir.
    import importlib

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app())


def test_health(client):
    r = client.get("/api/system/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_hardware(client):
    r = client.get("/api/system/hardware")
    assert r.status_code == 200
    body = r.json()
    assert "recommended_asr" in body
    assert "is_apple_silicon" in body


def test_topic_crud(client):
    r = client.post("/api/topics", json={"name": "Uni", "color": "#ff0000"})
    assert r.status_code == 201
    topic = r.json()
    assert topic["name"] == "Uni"

    r = client.get("/api/topics")
    assert r.status_code == 200
    overview = next(t for t in r.json() if t["id"] == topic["id"])
    assert overview["recording_count"] == 0
    assert overview["transcribed_count"] == 0
    assert overview["diarized_count"] == 0
    assert overview["exported_count"] == 0

    r = client.patch(f"/api/topics/{topic['id']}", json={"name": "Universität"})
    assert r.json()["name"] == "Universität"

    r = client.delete(f"/api/topics/{topic['id']}")
    assert r.status_code == 204


def test_topic_overview_counts_artifacts_and_exports(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import DiarizationRun, Recording, Topic, Transcript, Word

    with Session(db.get_engine()) as s:
        topic = Topic(name="Vorlesung")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Termin 1", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        transcript = Transcript(recording_id=rec.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        s.add(DiarizationRun(recording_id=rec.id, model="test"))
        s.commit()
        topic_id = topic.id
        recording_id = rec.id

    r = client.get("/api/topics")
    assert r.status_code == 200
    overview = next(t for t in r.json() if t["id"] == topic_id)
    assert overview["recording_count"] == 1
    assert overview["transcribed_count"] == 1
    assert overview["diarized_count"] == 1
    assert overview["exported_count"] == 0

    r = client.get(f"/api/recordings/{recording_id}/export?format=txt")
    assert r.status_code == 200

    r = client.get("/api/topics")
    overview = next(t for t in r.json() if t["id"] == topic_id)
    assert overview["exported_count"] == 1


def test_builtin_templates_seeded(client):
    # Built-in summary templates should be present after init.
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import SummaryTemplate

    with Session(db.get_engine()) as s:
        rows = s.exec(select(SummaryTemplate)).all()
    names = {t.name for t in rows}
    assert len(rows) >= 4
    # The standalone tasks template was retired in favour of the action-items feature.
    assert "Action Items / To-dos" not in names


def test_seed_prunes_obsolete_builtin_template(client):
    # An obsolete built-in template is removed on re-seed; summaries that
    # referenced it keep their content but lose the dangling template link.
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, Summary, SummaryTemplate, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Alt")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Alt", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        stale = SummaryTemplate(name="Action Items / To-dos", is_builtin=True)
        s.add(stale)
        s.flush()
        summary = Summary(recording_id=rec.id, template_id=stale.id, model="", content="x")
        s.add(summary)
        s.commit()
        summary_id = summary.id

    db._seed_builtin_templates()

    with Session(db.get_engine()) as s:
        names = {t.name for t in s.exec(select(SummaryTemplate)).all()}
        assert "Action Items / To-dos" not in names
        kept = s.get(Summary, summary_id)
        assert kept is not None
        assert kept.template_id is None


def test_known_speaker_list_merges_duplicate_names(client):
    import numpy as np
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.ml.embedding import to_blob
    from tarscribe_backend.models import KnownSpeaker, Recording, SpeakerLabel, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Stimmen")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Interview", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        first = KnownSpeaker(
            name="Ada",
            embedding_blob=to_blob(np.array([1.0, 0.0], dtype=np.float32)),
            sample_count=1,
        )
        duplicate = KnownSpeaker(
            name="Ada",
            embedding_blob=to_blob(np.array([0.0, 1.0], dtype=np.float32)),
            sample_count=2,
        )
        s.add(first)
        s.add(duplicate)
        s.flush()
        s.add(
            SpeakerLabel(
                recording_id=rec.id,
                original_label="SPEAKER_01",
                display_name=duplicate.name,
                known_speaker_id=duplicate.id,
            )
        )
        s.commit()
        first_id = first.id
        duplicate_id = duplicate.id

    r = client.get("/api/known-speakers")
    assert r.status_code == 200
    speakers = [s for s in r.json() if s["name"] == "Ada"]
    assert speakers == [{"id": first_id, "name": "Ada", "color": "#10b981", "sample_count": 3}]

    with Session(db.get_engine()) as s:
        assert s.get(KnownSpeaker, duplicate_id) is None
        label = s.exec(select(SpeakerLabel).where(SpeakerLabel.original_label == "SPEAKER_01")).one()
        assert label.known_speaker_id == first_id
        assert label.display_name == "Ada"


def test_known_speaker_rename_merges_same_name(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import KnownSpeaker

    with Session(db.get_engine()) as s:
        first = KnownSpeaker(name="Sam", sample_count=1)
        second = KnownSpeaker(name="Taylor", sample_count=4)
        s.add(first)
        s.add(second)
        s.commit()
        first_id = first.id
        second_id = second.id

    r = client.patch(f"/api/known-speakers/{second_id}", json={"name": "Sam"})
    assert r.status_code == 200
    assert r.json()["id"] == second_id
    assert r.json()["name"] == "Sam"
    assert r.json()["sample_count"] == 5

    with Session(db.get_engine()) as s:
        assert s.get(KnownSpeaker, first_id) is None
        assert s.get(KnownSpeaker, second_id).sample_count == 5


def test_import_local_recording_accepts_native_capture_file(client, monkeypatch):
    from pathlib import Path

    import tarscribe_backend.routers.recordings as recordings
    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = recordings.get_settings().native_recordings_dir / "capture.caf"
    source.write_bytes(b"caf")

    def fake_normalize(src: Path, dst: Path) -> None:
        dst.write_bytes(src.read_bytes())

    monkeypatch.setattr(recordings, "normalize_to_wav", fake_normalize)
    monkeypatch.setattr(recordings, "probe_duration", lambda _path: 3.5)

    r = client.post(
        "/api/recordings/import-local",
        json={"topic_id": topic["id"], "title": "Systemaudio", "path": str(source)},
    )
    assert r.status_code == 201
    assert r.json()["title"] == "Systemaudio"
    assert r.json()["duration_sec"] == 3.5
    assert not source.exists()


def test_import_local_recording_rejects_files_outside_native_capture_dir(client, tmp_path):
    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = tmp_path / "outside.caf"
    source.write_bytes(b"caf")

    r = client.post(
        "/api/recordings/import-local",
        json={"topic_id": topic["id"], "path": str(source)},
    )
    assert r.status_code == 403


def test_import_local_mixed_recording_combines_system_audio_and_microphone(client, monkeypatch):
    from pathlib import Path

    import tarscribe_backend.routers.recordings as recordings

    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = recordings.get_settings().native_recordings_dir / "capture.caf"
    source.write_bytes(b"system")

    def fake_mix(system_audio: Path, microphone_audio: Path, dst: Path) -> None:
        dst.write_bytes(system_audio.read_bytes() + b"+" + microphone_audio.read_bytes())

    monkeypatch.setattr(recordings, "mix_to_wav", fake_mix)
    monkeypatch.setattr(recordings, "probe_duration", lambda _path: 4.0)

    r = client.post(
        "/api/recordings/import-local-mixed",
        data={"topic_id": topic["id"], "title": "Gemischt", "path": str(source)},
        files={"microphone": ("microphone.webm", b"microphone", "audio/webm")},
    )
    assert r.status_code == 201
    assert r.json()["title"] == "Gemischt"
    assert r.json()["duration_sec"] == 4.0
    assert not source.exists()


def test_delete_recording_removes_dependent_rows_even_when_audio_is_missing(client):
    from pathlib import Path

    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        DiarizationRun,
        Job,
        JobPhase,
        JobStatus,
        ManualEdit,
        Recording,
        Segment,
        SpeakerLabel,
        Summary,
        Topic,
        Transcript,
        Word,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Defekt", audio_path="/tmp/missing-tarscribe.wav")
        s.add(rec)
        s.flush()
        transcript = Transcript(recording_id=rec.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        run = DiarizationRun(recording_id=rec.id, model="test")
        s.add(run)
        s.flush()
        s.add(Segment(run_id=run.id, start=0, end=1, speaker_label="SPEAKER_00"))
        s.add(SpeakerLabel(recording_id=rec.id, original_label="SPEAKER_00"))
        s.add(ManualEdit(recording_id=rec.id, edit_type="rename"))
        s.add(Summary(recording_id=rec.id, model="test"))
        s.add(Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.done))
        s.commit()
        recording_id = rec.id

    assert not Path("/tmp/missing-tarscribe.wav").exists()
    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 204

    with Session(db.get_engine()) as s:
        assert s.get(Recording, recording_id) is None
        assert not s.exec(select(Job).where(Job.recording_id == recording_id)).all()
        assert not s.exec(select(Transcript).where(Transcript.recording_id == recording_id)).all()
        assert not s.exec(select(DiarizationRun).where(DiarizationRun.recording_id == recording_id)).all()


def test_delete_recording_with_finalized_live_session(client):
    """Deleting a recording that has a linked LiveRecordingSession must succeed."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import LiveRecordingSession, LiveSessionStatus, Recording, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Live", audio_path="/tmp/live-test.wav")
        s.add(rec)
        s.flush()
        live = LiveRecordingSession(
            id="abc123",
            topic_id=topic.id,
            title="Live",
            status=LiveSessionStatus.completed,
            pcm_path="/tmp/live.pcm",
            finalized_recording_id=rec.id,
        )
        s.add(live)
        s.commit()
        recording_id = rec.id

    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 204

    with Session(db.get_engine()) as s:
        assert s.get(Recording, recording_id) is None
        assert s.get(LiveRecordingSession, "abc123") is None


def test_delete_recording_rejects_running_job(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Aktiv", audio_path="/tmp/active-tarscribe.wav")
        s.add(rec)
        s.flush()
        s.add(Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.running))
        s.commit()
        recording_id = rec.id

    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 409


def test_summary_runner_persists_streamed_content_and_exposes_it_via_api(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        Summary,
        SummaryTemplate,
        Topic,
        Transcript,
        Word,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        recording = Recording(topic_id=topic.id, title="Stream", audio_path="/tmp/stream.wav")
        s.add(recording)
        s.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        template = SummaryTemplate(name="Test", user_prompt_template="{{transcript}}")
        s.add(template)
        s.flush()
        summary = Summary(recording_id=recording.id, template_id=template.id, model="")
        s.add(summary)
        job = Job(recording_id=recording.id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.commit()
        recording_id = recording.id
        template_id = template.id
        summary_id = summary.id
        job_id = job.id

    events = []
    monkeypatch.setattr(llm, "get_llm_config", lambda: {"model": "local-test", "base_url": "http://llm"})
    monkeypatch.setattr(llm, "stream_chat", lambda *args, **kwargs: iter(("Hallo", " Welt")))
    monkeypatch.setattr(jobs.hub, "broadcast", events.append)

    jobs._run_summary(recording_id, job_id, template_id, summary_id)

    r = client.get(f"/api/summaries/{summary_id}")
    assert r.status_code == 200
    assert r.json()["content"] == "Hallo Welt"
    job_payload = client.get(f"/api/recordings/{recording_id}/jobs").json()[0]
    assert job_payload["job_id"] == job_id
    assert "id" not in job_payload
    assert any(event.get("type") == "summary" and event.get("delta") == "Hallo" for event in events)
    assert any(event.get("type") == "summary" and event.get("done") is True for event in events)

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.done


def test_stale_jobs_failed_on_startup(client):
    """Jobs left pending/running by a crashed backend are failed on init."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        RecordingStatus,
        Topic,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Crash")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="Unterbrochen",
            audio_path="/tmp/missing.wav",
            status=RecordingStatus.transcribing,
        )
        s.add(rec)
        s.flush()
        stuck = Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.running)
        queued = Job(recording_id=rec.id, phase=JobPhase.summarize, status=JobStatus.pending)
        done = Job(recording_id=rec.id, phase=JobPhase.diarization, status=JobStatus.done)
        s.add(stuck)
        s.add(queued)
        s.add(done)
        s.commit()
        rec_id, stuck_id, queued_id, done_id = rec.id, stuck.id, queued.id, done.id

    db._mark_stale_jobs()  # what init_db runs on the next startup

    with Session(db.get_engine()) as s:
        assert s.get(Job, stuck_id).status == JobStatus.failed
        assert s.get(Job, queued_id).status == JobStatus.failed
        assert s.get(Job, done_id).status == JobStatus.done
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def _setup_diarization_job(with_transcript: bool):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        RecordingStatus,
        Topic,
        Transcript,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Dia")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="X",
            audio_path="/tmp/missing.wav",
            status=RecordingStatus.uploaded,
        )
        s.add(rec)
        s.flush()
        if with_transcript:
            s.add(Transcript(recording_id=rec.id, asr_model="test"))
        job = Job(recording_id=rec.id, phase=JobPhase.diarization, status=JobStatus.pending)
        s.add(job)
        s.commit()
        return rec.id, job.id


def test_diarization_failure_without_transcript_marks_failed(client, monkeypatch):
    """A failed diarization on a transcript-less recording must not leave it 'ready'
    (which would render a blank detail page with no way to transcribe)."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.settings_store as settings_store
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    # Force the early no-token failure so the test stays hermetic (no model load).
    monkeypatch.setattr(settings_store, "get_hf_token", lambda: None)
    rec_id, job_id = _setup_diarization_job(with_transcript=False)
    jobs._run_diarization(rec_id, job_id, {})  # raises -> failure path

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def test_diarization_failure_with_transcript_stays_ready(client, monkeypatch):
    """With a transcript present, a failed (optional) diarization still leaves the
    recording usable as 'ready'."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.settings_store as settings_store
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    monkeypatch.setattr(settings_store, "get_hf_token", lambda: None)
    rec_id, job_id = _setup_diarization_job(with_transcript=True)
    jobs._run_diarization(rec_id, job_id, {})

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert s.get(Recording, rec_id).status == RecordingStatus.ready

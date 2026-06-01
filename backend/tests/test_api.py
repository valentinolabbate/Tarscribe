"""End-to-end smoke tests against the FastAPI app using a temp data dir."""

from __future__ import annotations

import os
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
    assert any(t["id"] == topic["id"] for t in r.json())

    r = client.patch(f"/api/topics/{topic['id']}", json={"name": "Universität"})
    assert r.json()["name"] == "Universität"

    r = client.delete(f"/api/topics/{topic['id']}")
    assert r.status_code == 204


def test_builtin_templates_seeded(client):
    # Built-in summary templates should be present after init.
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import SummaryTemplate

    with Session(db.get_engine()) as s:
        rows = s.exec(select(SummaryTemplate)).all()
    assert len(rows) >= 5


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

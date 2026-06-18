"""Tests for the quick dictation inbox flow."""

from __future__ import annotations

import importlib
import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

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


def test_dictation_upload_creates_inbox_and_queues_asr(client, monkeypatch):
    from pathlib import Path

    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.routers.recordings as recordings
    from tarscribe_backend.models import Job, JobPhase, Recording, Topic

    def fake_normalize(src: Path, dst: Path) -> None:
        dst.write_bytes(src.read_bytes())

    monkeypatch.setattr(recordings, "normalize_to_wav", fake_normalize)
    monkeypatch.setattr(recordings, "probe_duration", lambda _path: 2.5)
    monkeypatch.setattr(jobs._executor, "submit", lambda *a, **k: None)

    r = client.post(
        "/api/dictations",
        data={"title": "Diktat Test"},
        files={"file": ("note.webm", b"audio", "audio/webm")},
    )
    assert r.status_code == 201
    data = r.json()
    assert data["topic_name"] == "Inbox"
    assert data["recording"]["kind"] == "dictation"
    assert data["recording"]["title"] == "Diktat Test"
    assert data["job_id"] > 0

    with Session(db.get_engine()) as s:
        topics = s.exec(select(Topic).where(Topic.name == "Inbox")).all()
        assert len(topics) == 1
        rec = s.get(Recording, data["recording"]["id"])
        assert rec.kind == "dictation"
        assert rec.status == "queued"
        job = s.get(Job, data["job_id"])
        assert job.phase == JobPhase.asr

    r = client.post(
        "/api/dictations",
        files={"file": ("second.webm", b"audio", "audio/webm")},
    )
    assert r.status_code == 201
    with Session(db.get_engine()) as s:
        assert len(s.exec(select(Topic).where(Topic.name == "Inbox")).all()) == 1


def test_dictation_postprocess_titles_moves_and_creates_action_items(client, monkeypatch):
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import ActionItem, Recording, Topic, Transcript, Word

    with Session(db.get_engine()) as s:
        inbox = Topic(name="Inbox")
        project = Topic(name="Projekt Alpha")
        s.add(inbox)
        s.add(project)
        s.flush()
        rec = Recording(
            topic_id=inbox.id,
            title="Diktat 11.06.",
            audio_path="/tmp/missing.wav",
            kind="dictation",
        )
        s.add(rec)
        s.flush()
        transcript = Transcript(recording_id=rec.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Bitte "))
        s.add(Word(transcript_id=transcript.id, idx=1, start=1, end=2, text="Folien aktualisieren"))
        s.commit()
        rec_id = rec.id
        project_id = project.id

    def fake_chat(_messages):
        return (
            '{"title":"Folien für Projekt Alpha",'
            '"topic_name":"Projekt Alpha","topic_confidence":0.92,'
            '"action_items":[{"kind":"task","text":"Folien aktualisieren",'
            '"assignee":null,"due":"morgen","due_date":"2026-06-19"}]}'
        )

    monkeypatch.setattr(jobs, "_llm_chat_fn", lambda: fake_chat)
    jobs._maybe_postprocess_dictation(rec_id)

    with Session(db.get_engine()) as s:
        rec = s.get(Recording, rec_id)
        assert rec.title == "Folien für Projekt Alpha"
        assert rec.topic_id == project_id
        items = s.exec(select(ActionItem).where(ActionItem.recording_id == rec_id)).all()
        assert [(item.kind, item.text) for item in items] == [("task", "Folien aktualisieren")]
        assert items[0].due == "morgen"
        assert items[0].due_date == "2026-06-19"

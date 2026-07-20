"""Regression coverage for non-destructive transcript corrections."""

from __future__ import annotations

import importlib
import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tempfile.mkdtemp(prefix="tarscribe-quality-"))
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


def _recording_with_words():
    from sqlmodel import Session
    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, Topic, Transcript, Word

    with Session(db.get_engine()) as session:
        topic = Topic(name="Energie")
        session.add(topic)
        session.flush()
        recording = Recording(topic_id=topic.id, title="Preisrunde", audio_path="/tmp/audio.wav")
        session.add(recording)
        session.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        session.add(transcript)
        session.flush()
        session.add_all(
            [
                Word(transcript_id=transcript.id, idx=0, start=0, end=0.4, text=" Epic", confidence=0.22),
                Word(transcript_id=transcript.id, idx=1, start=0.4, end=0.8, text=" Spot", confidence=0.8),
            ]
        )
        session.commit()
        return recording.id


def test_correction_overlays_raw_words_and_rejects_stale_revisions(client, monkeypatch):
    import tarscribe_backend.routers.quality as quality

    monkeypatch.setattr(quality, "enqueue_embedding", lambda _recording_id: None)
    recording_id = _recording_with_words()
    before = client.get(f"/api/recordings/{recording_id}/transcript")
    assert before.json()["text"] == "Epic Spot"
    assert before.json()["quality"]["critical_count"] == 1

    response = client.post(
        f"/api/recordings/{recording_id}/corrections",
        json={
            "expected_revision": 0,
            "start_word_idx": 0,
            "end_word_idx": 1,
            "expected_original_text": " Epic Spot",
            "corrected_text": " EPEX Spot",
        },
    )
    assert response.status_code == 200
    assert response.json()["transcript_revision"] == 1

    effective = client.get(f"/api/recordings/{recording_id}/transcript").json()
    assert effective["text"] == "EPEX Spot"
    assert effective["raw_text"] == "Epic Spot"
    assert effective["words"][0]["raw_text"] == " Epic Spot"

    stale = client.post(
        f"/api/recordings/{recording_id}/corrections",
        json={
            "expected_revision": 0,
            "start_word_idx": 0,
            "end_word_idx": 0,
            "expected_original_text": " Epic",
            "corrected_text": " EPEX",
        },
    )
    assert stale.status_code == 409

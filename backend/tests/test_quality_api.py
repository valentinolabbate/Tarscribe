"""Regression coverage for non-destructive transcript corrections."""

from __future__ import annotations

import importlib
import tempfile
from concurrent.futures import ThreadPoolExecutor

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
    assert response.json()["quality_report"]["quality"]["open_count"] == 0

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


def test_acknowledgement_is_idempotent_and_does_not_change_transcript(client, monkeypatch):
    from sqlmodel import Session, select
    import tarscribe_backend.db as db
    from tarscribe_backend.models import TranscriptCorrection
    import tarscribe_backend.routers.quality as quality

    def fail_reindex(_recording_id):
        raise AssertionError("acknowledgement must not enqueue reindexing")

    monkeypatch.setattr(quality, "enqueue_embedding", fail_reindex)
    recording_id = _recording_with_words()
    before = client.get(f"/api/recordings/{recording_id}/transcript").json()
    assert before["revision"] == 0
    assert before["text"] == "Epic Spot"
    assert before["raw_text"] == "Epic Spot"
    assert before["quality"]["open_count"] == 1

    payload = {
        "expected_revision": 0,
        "start_word_idx": 0,
        "end_word_idx": 0,
        "expected_original_text": " Epic",
    }
    first = client.post(
        f"/api/recordings/{recording_id}/quality/acknowledge",
        json=payload,
    )
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["transcript_revision"] == 0
    assert first_body["reindex_scheduled"] is False
    assert first_body["acknowledgement"]["status"] == "ignored"
    assert first_body["acknowledgement"]["original_text"] == " Epic"
    assert first_body["acknowledgement"]["corrected_text"] == " Epic"
    assert first_body["quality_report"]["quality"]["open_count"] == 0
    assert first_body["quality_report"]["quality"]["critical_count"] == 0
    assert first_body["quality_report"]["issues"] == []

    second = client.post(
        f"/api/recordings/{recording_id}/quality/acknowledge",
        json=payload,
    )
    assert second.status_code == 200
    assert second.json()["acknowledgement"]["id"] == first_body["acknowledgement"]["id"]

    with Session(db.get_engine()) as session:
        acknowledgements = session.exec(
            select(TranscriptCorrection).where(
                TranscriptCorrection.recording_id == recording_id,
                TranscriptCorrection.status == "ignored",
            )
        ).all()
    assert len(acknowledgements) == 1

    transcript = client.get(f"/api/recordings/{recording_id}/transcript").json()
    assert transcript["revision"] == 0
    assert transcript["text"] == "Epic Spot"
    assert transcript["raw_text"] == "Epic Spot"
    assert transcript["quality"]["open_count"] == 0

    report = client.get(f"/api/recordings/{recording_id}/quality").json()
    assert report["revision"] == 0
    assert report["quality"]["open_count"] == 0
    assert report["issues"] == []


def test_concurrent_acknowledgements_create_one_record(client):
    from sqlmodel import Session, select
    import tarscribe_backend.db as db
    from tarscribe_backend.models import TranscriptCorrection

    recording_id = _recording_with_words()
    payload = {
        "expected_revision": 0,
        "start_word_idx": 0,
        "end_word_idx": 0,
        "expected_original_text": " Epic",
    }

    def acknowledge():
        return client.post(
            f"/api/recordings/{recording_id}/quality/acknowledge",
            json=payload,
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: acknowledge(), range(4)))

    assert [response.status_code for response in responses] == [200] * 4
    acknowledgement_ids = {
        response.json()["acknowledgement"]["id"] for response in responses
    }
    assert len(acknowledgement_ids) == 1
    with Session(db.get_engine()) as session:
        acknowledgements = session.exec(
            select(TranscriptCorrection).where(
                TranscriptCorrection.recording_id == recording_id,
                TranscriptCorrection.status == "ignored",
            )
        ).all()
    assert len(acknowledgements) == 1


def test_acknowledgement_rejects_non_issue_and_stale_anchor(client):
    recording_id = _recording_with_words()

    non_issue = client.post(
        f"/api/recordings/{recording_id}/quality/acknowledge",
        json={
            "expected_revision": 0,
            "start_word_idx": 1,
            "end_word_idx": 1,
            "expected_original_text": " Spot",
        },
    )
    assert non_issue.status_code == 409

    stale_text = client.post(
        f"/api/recordings/{recording_id}/quality/acknowledge",
        json={
            "expected_revision": 0,
            "start_word_idx": 0,
            "end_word_idx": 0,
            "expected_original_text": " Epos",
        },
    )
    assert stale_text.status_code == 409

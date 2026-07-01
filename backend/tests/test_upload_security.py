"""Upload and storage path security regressions."""

from __future__ import annotations

import importlib
import tempfile
from pathlib import Path

import pytest
from sqlmodel import Session


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-upload-security-")
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


def test_executable_uploads_are_rejected(client):
    topic = client.post("/api/topics", json={"name": "Uploads"}).json()

    recording = client.post(
        "/api/recordings",
        data={"topic_id": topic["id"]},
        files={"file": ("payload.exe", b"MZ", "application/octet-stream")},
    )
    document = client.post(
        "/api/documents",
        data={"topic_id": topic["id"]},
        files={"file": ("payload.exe", b"MZ", "application/octet-stream")},
    )

    assert recording.status_code == 400
    assert document.status_code == 400


def test_import_local_rejects_relative_traversal_path(client):
    topic = client.post("/api/topics", json={"name": "Native"}).json()

    response = client.post(
        "/api/recordings/import-local",
        json={"topic_id": topic["id"], "path": "../../etc/passwd"},
    )

    assert response.status_code == 400


def test_document_download_ignores_manipulated_file_path(client):
    from tarscribe_backend.models import Document

    import tarscribe_backend.db as db

    topic = client.post("/api/topics", json={"name": "Docs"}).json()
    uploaded = client.post(
        "/api/documents",
        data={"topic_id": topic["id"]},
        files={"file": ("notes.txt", b"internal document", "text/plain")},
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]

    with Session(db.get_engine()) as session:
        doc = session.get(Document, document_id)
        assert doc is not None
        assert Path(doc.file_path).name == f"{document_id}.txt"
        doc.file_path = "/etc/passwd"
        session.add(doc)
        session.commit()

    downloaded = client.get(f"/api/documents/{document_id}/file")

    assert downloaded.status_code == 200
    assert downloaded.content == b"internal document"


def test_send_to_folder_rejects_unconfigured_export_path(client):
    from tarscribe_backend.models import Recording, Topic, Transcript, Word

    import tarscribe_backend.db as db

    with Session(db.get_engine()) as session:
        topic = Topic(name="Export")
        session.add(topic)
        session.commit()
        session.refresh(topic)
        recording = Recording(
            topic_id=topic.id,
            title="Weekly",
            audio_path="/tmp/missing.wav",
        )
        session.add(recording)
        session.commit()
        session.refresh(recording)
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        session.add(transcript)
        session.commit()
        session.refresh(transcript)
        session.add(Word(transcript_id=transcript.id, idx=0, start=0.0, end=1.0, text="Hallo"))
        session.commit()
        recording_id = recording.id

    response = client.post(f"/api/recordings/{recording_id}/send-to-folder")

    assert response.status_code == 400

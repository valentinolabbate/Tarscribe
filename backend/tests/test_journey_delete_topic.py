"""Critical journey: deleting an empty topic removes topic-owned data safely."""

from __future__ import annotations

import importlib
import tempfile
from pathlib import Path

import pytest
from sqlmodel import Session, select


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-journey-delete-topic-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.jobs as jobs

    monkeypatch.setattr(jobs, "enqueue_document_embedding", lambda document_id: 3000)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app())


def test_delete_topic_removes_documents_rag_chunks_and_preserves_chat_history(client):
    import tarscribe_backend.db as db
    from tarscribe_backend.models import ChatMessage, ChatSession, Document, RagChunk, Topic

    topic = client.post("/api/topics", json={"name": "Projekt"}).json()
    uploaded = client.post(
        "/api/documents",
        data={"topic_id": topic["id"], "title": "Notizen"},
        files={"file": ("notizen.txt", b"Projektwissen", "text/plain")},
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]
    document_path = Path(uploaded.json()["file_path"])

    chat = client.post(
        "/api/chats",
        json={"scope": "global", "topic_id": topic["id"], "title": "Projektchat"},
    )
    assert chat.status_code == 201
    chat_id = chat.json()["id"]
    message = client.post(
        f"/api/chats/{chat_id}/messages",
        json={"role": "user", "content": "Was ist offen?"},
    )
    assert message.status_code == 201

    with Session(db.get_engine()) as session:
        session.add(
            RagChunk(
                recording_id=None,
                topic_id=topic["id"],
                document_id=document_id,
                source_type="document",
                text="Projektwissen",
                content_hash="journey",
                embed_model="test",
            )
        )
        session.commit()

    deleted = client.delete(f"/api/topics/{topic['id']}")
    assert deleted.status_code == 204

    assert client.get("/api/topics").json() == []
    assert client.get(f"/api/documents?topic_id={topic['id']}").json() == []
    assert not document_path.exists()

    chat_after_delete = client.get(f"/api/chats/{chat_id}").json()
    assert chat_after_delete["topic_id"] is None
    assert chat_after_delete["messages"][0]["content"] == "Was ist offen?"

    with Session(db.get_engine()) as session:
        assert session.get(Topic, topic["id"]) is None
        assert session.get(Document, document_id) is None
        assert session.exec(select(RagChunk)).all() == []
        assert session.get(ChatSession, chat_id) is not None
        assert session.exec(select(ChatMessage)).one().session_id == chat_id

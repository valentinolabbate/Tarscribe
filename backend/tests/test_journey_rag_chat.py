"""Critical journey: document upload, indexing trigger, and RAG chat."""

from __future__ import annotations

import importlib
import json
import tempfile

import pytest
from sqlmodel import Session


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-journey-rag-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import Document

    queued_documents: list[int] = []

    def fake_enqueue_document_embedding(document_id: int) -> int:
        queued_documents.append(document_id)
        with Session(db.get_engine()) as session:
            document = session.get(Document, document_id)
            assert document is not None
            document.status = "ready"
            document.text_chars = 41
            session.add(document)
            session.commit()
        return 3000 + len(queued_documents) - 1

    monkeypatch.setattr(jobs, "enqueue_document_embedding", fake_enqueue_document_embedding)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)

    import tarscribe_backend.routers.rag as rag_router

    captured: dict[str, object] = {}

    def fake_search(session, query: str, **kwargs):
        captured["query"] = query
        captured["search_kwargs"] = kwargs
        return [
            {
                "recording_id": None,
                "recording_title": "Handbuch",
                "topic_id": captured["topic_id"],
                "document_id": captured["document_id"],
                "source_type": "document",
                "start_sec": None,
                "end_sec": None,
                "speaker": None,
                "text": "Wichtige Referenz zum Projekt und zur Entscheidung.",
            }
        ]

    def fake_stream_chat(messages, model, base_url, **kwargs):
        captured["messages"] = messages
        captured["llm_kwargs"] = kwargs
        yield "Die Referenz nennt die Entscheidung"
        yield " [1]."

    monkeypatch.setattr(rag_router.R, "rag_enabled", lambda: True)
    monkeypatch.setattr(rag_router.R, "search", fake_search)
    monkeypatch.setattr(
        rag_router.L,
        "get_llm_config",
        lambda: {
            "provider": "custom",
            "base_url": "http://localhost:1234/v1",
            "model": "journey-chat",
            "temperature": 0.2,
            "top_p": None,
            "top_k": None,
            "max_tokens": None,
            "api_key": None,
            "reasoning_effort": None,
        },
    )
    monkeypatch.setattr(rag_router.L, "stream_chat", fake_stream_chat)

    test_client = TestClient(main.create_app())
    test_client.queued_documents = queued_documents
    test_client.captured = captured
    return test_client


def _events(response_text: str) -> list[dict]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response_text.splitlines()
        if line.startswith("data: ")
    ]


def test_document_upload_reindex_and_rag_chat_returns_sourced_answer(client):
    topic = client.post("/api/topics", json={"name": "Wissen"}).json()
    uploaded = client.post(
        "/api/documents",
        data={"topic_id": topic["id"], "title": "Handbuch"},
        files={"file": ("handbuch.txt", b"Wichtige Referenz zum Projekt.", "text/plain")},
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]
    client.captured["topic_id"] = topic["id"]
    client.captured["document_id"] = document_id
    assert client.queued_documents == [document_id]

    reindex = client.post(f"/api/documents/{document_id}/reindex")
    assert reindex.status_code == 200
    assert reindex.json() == {"enqueued": True}
    assert client.queued_documents == [document_id, document_id]
    assert client.get(f"/api/documents/{document_id}").json()["status"] == "ready"

    chat = client.post(
        "/api/rag/chat",
        json={
            "topic_id": topic["id"],
            "messages": [{"role": "user", "content": "Welche Entscheidung steht im Handbuch?"}],
        },
    )
    assert chat.status_code == 200
    events = _events(chat.text)
    assert events[0]["type"] == "sources"
    assert events[0]["sources"][0]["document_id"] == document_id
    assert "".join(event.get("content", "") for event in events) == "Die Referenz nennt die Entscheidung [1]."

    llm_messages = client.captured["messages"]
    assert "Wichtige Referenz zum Projekt" in llm_messages[-1]["content"]
    assert client.captured["search_kwargs"]["topic_id"] == topic["id"]

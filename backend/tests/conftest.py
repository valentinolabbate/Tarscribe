"""Shared test fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_rag_autotrigger(monkeypatch):
    """Stop ASR/summary/document jobs from enqueuing real embedding work in tests.

    These auto-index triggers would otherwise spawn a **background thread** on the
    embedding executor. With a live embedding endpoint reachable, that thread can
    still be indexing after the test's DB has been torn down / reloaded, then write
    against the next test's database (FK errors, flaky failures). Tests that
    exercise RAG call ``rag.index_recording`` / ``rag.index_document`` directly.
    """
    try:
        import tarscribe_backend.jobs as jobs

        monkeypatch.setattr(jobs, "schedule_reindex", lambda *_a, **_k: None)
        monkeypatch.setattr(jobs, "enqueue_document_embedding", lambda *_a, **_k: None)
    except Exception:  # noqa: BLE001 - jobs may not be imported in some test runs
        pass

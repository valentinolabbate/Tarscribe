"""Shared test fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_rag_autotrigger(monkeypatch):
    """Stop ASR/summary jobs from enqueuing real embedding jobs during tests.

    The RAG auto-index trigger would otherwise spawn a background job that calls a
    (non-existent) embedding endpoint. Tests that exercise RAG opt back in explicitly.
    """
    try:
        import tarscribe_backend.jobs as jobs

        monkeypatch.setattr(jobs, "schedule_reindex", lambda *_a, **_k: None)
    except Exception:  # noqa: BLE001 - jobs may not be imported in some test runs
        pass

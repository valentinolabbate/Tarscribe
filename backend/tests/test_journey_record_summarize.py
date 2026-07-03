"""Critical journey: live recording finalization followed by summarization."""

from __future__ import annotations

import importlib
import json
import tempfile

import pytest
from sqlmodel import Session


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-journey-record-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.live_analysis as live_analysis

    monkeypatch.setattr(live_analysis.LiveAnalysisService, "tick", lambda self, sid: None)
    monkeypatch.setattr(live_analysis.LiveAnalysisService, "_diarization_tick", lambda *a, **kw: None)
    live_analysis._service = None

    import tarscribe_backend.jobs as jobs

    queued_asr_jobs: list[int] = []

    def fake_enqueue_asr(recording_id: int, override: str | None = None) -> int:
        queued_asr_jobs.append(recording_id)
        return 1000 + len(queued_asr_jobs) - 1

    monkeypatch.setattr(jobs, "enqueue_asr", fake_enqueue_asr)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)

    import tarscribe_backend.routers.llm as llm_router
    from tarscribe_backend.models import Summary

    summary_clarifications: list[str | None] = []

    def fake_enqueue_summary(
        recording_id: int,
        template_id: int,
        summary_id: int,
        clarification: str | None = None,
    ) -> int:
        summary_clarifications.append(clarification)
        with Session(db.get_engine()) as session:
            summary = session.get(Summary, summary_id)
            assert summary is not None
            summary.content = "## Kurzfassung\n\nLive-Transkript wurde zusammengefasst."
            session.add(summary)
            session.commit()
        return 2000

    monkeypatch.setattr(llm_router, "enqueue_summary", fake_enqueue_summary)

    test_client = TestClient(main.create_app())
    test_client.queued_asr_jobs = queued_asr_jobs
    test_client.summary_clarifications = summary_clarifications
    return test_client


def _create_recording(topic_id: int) -> int:
    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, RecordingStatus

    with Session(db.get_engine()) as session:
        recording = Recording(
            topic_id=topic_id,
            title="Live Journeysitzung",
            audio_path="/tmp/tarscribe-journey-live.wav",
            status=RecordingStatus.uploaded,
        )
        session.add(recording)
        session.commit()
        session.refresh(recording)
        assert recording.id is not None
        return recording.id


def _set_live_snapshot(session_id: str) -> None:
    import tarscribe_backend.db as db
    from tarscribe_backend.models import LiveRecordingSession

    words = [
        {"start": 0.0, "end": 0.4, "text": "Heute ", "confidence": 0.95},
        {"start": 0.4, "end": 0.9, "text": "testen ", "confidence": 0.94},
        {"start": 0.9, "end": 1.2, "text": "wir", "confidence": 0.93},
    ]
    with Session(db.get_engine()) as session:
        live = session.get(LiveRecordingSession, session_id)
        assert live is not None
        live.transcript_snapshot_json = json.dumps({"revision": 1, "duration_sec": 1.2, "words": words})
        session.add(live)
        session.commit()


def test_live_recording_can_finish_transcribe_and_create_summary(client):
    topic = client.post("/api/topics", json={"name": "Journey"}).json()
    recording_id = _create_recording(topic["id"])

    live = client.post("/api/live-recordings", json={"topic_id": topic["id"], "title": "Live"}).json()
    session_id = live["id"]
    assert client.post(f"/api/live-recordings/{session_id}/pause").json()["status"] == "paused"
    assert client.post(f"/api/live-recordings/{session_id}/resume").json()["status"] == "recording"
    _set_live_snapshot(session_id)

    finished = client.post(
        f"/api/live-recordings/{session_id}/finish",
        json={"recording_id": recording_id},
    )
    assert finished.status_code == 200
    assert finished.json()["transcription_job_id"] == 1000
    assert client.queued_asr_jobs == [recording_id]

    transcript = client.get(f"/api/recordings/{recording_id}/transcript")
    assert transcript.status_code == 200
    assert transcript.json()["text"] == "Heute testen wir"

    client.put(
        "/api/llm/config",
        json={"provider": "custom", "base_url": "http://localhost:1234/v1", "model": "journey-model"},
    )
    template = client.post(
        "/api/templates",
        json={"name": "Kurz", "system_prompt": "", "user_prompt_template": "{{ transcript }}"},
    )
    assert template.status_code == 201

    summary_job = client.post(
        f"/api/recordings/{recording_id}/summarize",
        params={"template_id": template.json()["id"]},
        json={"clarification": "  Das Produkt heißt Tarscribe.  "},
    )
    assert summary_job.status_code == 200
    assert summary_job.json()["job_id"] == 2000
    assert client.summary_clarifications == ["Das Produkt heißt Tarscribe."]

    summary = client.get(f"/api/summaries/{summary_job.json()['summary_id']}")
    assert summary.status_code == 200
    assert "Live-Transkript wurde zusammengefasst" in summary.json()["content"]

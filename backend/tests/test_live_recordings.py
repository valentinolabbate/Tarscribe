"""Tests for live recording session lifecycle and PCM chunk handling."""

from __future__ import annotations

import importlib
import struct
import tempfile
from pathlib import Path

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-live-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    # Prevent background ML threads from loading heavy models during tests.
    import tarscribe_backend.live_analysis as la

    monkeypatch.setattr(la.LiveAnalysisService, "tick", lambda self, sid: None)
    monkeypatch.setattr(la.LiveAnalysisService, "_diarization_tick", lambda *a, **kw: None)
    la._service = None

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app())


# ── Helper to create a topic ────────────────────────────────────────────────

def _make_topic(client, name="Test") -> int:
    r = client.post("/api/topics", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _make_pcm_chunk(num_samples: int = 32000, channels: int = 1) -> bytes:
    """Return silent PCM16 data."""
    return b"\x00\x00" * num_samples * channels


# ── Session lifecycle ────────────────────────────────────────────────────────

def test_create_live_session(client):
    topic_id = _make_topic(client)
    r = client.post("/api/live-recordings", json={"topic_id": topic_id, "title": "Mein Test"})
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "recording"
    assert body["topic_id"] == topic_id
    assert body["title"] == "Mein Test"
    assert body["last_sequence_number"] == -1
    assert body["received_duration_sec"] == 0.0


def test_create_live_session_missing_topic(client):
    r = client.post("/api/live-recordings", json={"topic_id": 9999, "title": "X"})
    assert r.status_code == 404


def test_get_live_session(client):
    topic_id = _make_topic(client)
    r = client.post("/api/live-recordings", json={"topic_id": topic_id})
    sid = r.json()["id"]
    r2 = client.get(f"/api/live-recordings/{sid}")
    assert r2.status_code == 200
    assert r2.json()["id"] == sid


def test_pause_and_resume(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = client.post(f"/api/live-recordings/{sid}/pause")
    assert r.status_code == 200
    assert r.json()["status"] == "paused"

    r = client.post(f"/api/live-recordings/{sid}/resume")
    assert r.status_code == 200
    assert r.json()["status"] == "recording"


def test_pause_when_not_recording_fails(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    # Already recording, pause it
    client.post(f"/api/live-recordings/{sid}/pause")
    # Pause again should fail
    r = client.post(f"/api/live-recordings/{sid}/pause")
    assert r.status_code == 409


def test_finish_session(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = client.post(f"/api/live-recordings/{sid}/finish", json={"recording_id": None})
    assert r.status_code == 200
    assert r.json()["status"] == "completed"

    r2 = client.get(f"/api/live-recordings/{sid}")
    assert r2.json()["status"] == "completed"


def test_cancel_session(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = client.delete(f"/api/live-recordings/{sid}")
    assert r.status_code == 204

    r2 = client.get(f"/api/live-recordings/{sid}")
    assert r2.json()["status"] == "canceled"


# ── PCM chunk upload ─────────────────────────────────────────────────────────

def _upload_chunk(client, sid: str, seq: int, data: bytes) -> dict:
    r = client.post(
        f"/api/live-recordings/{sid}/chunks",
        content=data,
        headers={
            "Content-Type": "application/octet-stream",
            "X-Sequence-Number": str(seq),
            "X-Sample-Rate": "16000",
            "X-Channels": "1",
        },
    )
    return r


def test_chunk_upload_accepted(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    chunk = _make_pcm_chunk(32000)  # 2s at 16 kHz

    r = _upload_chunk(client, sid, 0, chunk)
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is True
    assert body["last_sequence_number"] == 0
    assert abs(body["received_duration_sec"] - 2.0) < 0.01


def test_chunk_upload_idempotent(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    chunk = _make_pcm_chunk(16000)  # 1s

    _upload_chunk(client, sid, 0, chunk)
    r = _upload_chunk(client, sid, 0, chunk)  # replay
    assert r.status_code == 200
    body = r.json()
    # Accepted (idempotent) but duration still just 1s
    assert body["accepted"] is True
    assert body["received_duration_sec"] < 1.1


def test_chunk_gap_rejected(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    chunk = _make_pcm_chunk(16000)

    r = _upload_chunk(client, sid, 2, chunk)  # gap: expected 0
    assert r.status_code == 422


def test_chunk_invalid_size_rejected(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = _upload_chunk(client, sid, 0, b"\x01")  # odd byte count — not PCM16
    assert r.status_code == 422


def test_multiple_chunks_accumulate(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    chunk = _make_pcm_chunk(16000)  # 1s per chunk

    _upload_chunk(client, sid, 0, chunk)
    r = _upload_chunk(client, sid, 1, chunk)
    assert r.status_code == 200
    body = r.json()
    assert body["last_sequence_number"] == 1
    assert abs(body["received_duration_sec"] - 2.0) < 0.01


# ── Feature flags ────────────────────────────────────────────────────────────

def test_live_transcription_enabled_flag_defaults_true(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["live_transcription_enabled"] is True
    assert body["live_speaker_detection_enabled"] is True


def test_live_transcription_enabled_flag_can_be_disabled(client):
    r = client.put("/api/settings", json={"live_transcription_enabled": False})
    assert r.status_code == 200
    assert r.json()["live_transcription_enabled"] is False


def test_recording_source_defaults_to_microphone_and_accepts_native_modes(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["recording_source"] == "microphone"

    r = client.put("/api/settings", json={"recording_source": "system_audio_and_microphone"})
    assert r.status_code == 200
    assert r.json()["recording_source"] == "system_audio_and_microphone"


# ── PCM cleanup ───────────────────────────────────────────────────────────────

def test_finish_schedules_pcm_cleanup(client, tmp_path, monkeypatch):
    import tarscribe_backend.routers.live_recordings as lr

    cleaned: list[str] = []
    monkeypatch.setattr(lr, "cleanup_session_dir", lambda p: cleaned.append(p))

    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    client.post(f"/api/live-recordings/{sid}/finish", json={"recording_id": None})

    # Give the background thread a moment to call cleanup_session_dir.
    import time
    time.sleep(0.05)
    assert len(cleaned) == 1


def test_cancel_schedules_pcm_cleanup(client, monkeypatch):
    import tarscribe_backend.routers.live_recordings as lr

    cleaned: list[str] = []
    monkeypatch.setattr(lr, "cleanup_session_dir", lambda p: cleaned.append(p))

    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    client.delete(f"/api/live-recordings/{sid}")

    import time
    time.sleep(0.05)
    assert len(cleaned) == 1


# ── live_audio module unit tests ─────────────────────────────────────────────

def test_validate_append_first_chunk(tmp_path):
    from tarscribe_backend.live_audio import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x01\x00" * 16000  # 1s mono PCM16
    result = validate_and_append_chunk(pcm_path, chunk, 0, 0, 16000, 1)
    assert result.accepted
    assert result.last_sequence_number == 0
    assert abs(result.received_duration_sec - 1.0) < 0.01
    assert pcm_path.exists()


def test_validate_append_idempotent(tmp_path):
    from tarscribe_backend.live_audio import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x00\x00" * 8000
    validate_and_append_chunk(pcm_path, chunk, 0, 0, 16000, 1)
    result = validate_and_append_chunk(pcm_path, chunk, 0, 1, 16000, 1)
    assert result.accepted
    assert result.reason == "already_processed"


def test_validate_append_gap(tmp_path):
    from tarscribe_backend.live_audio import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x00\x00" * 8000
    result = validate_and_append_chunk(pcm_path, chunk, 2, 0, 16000, 1)
    assert not result.accepted
    assert "gap" in result.reason


def test_build_wav_window(tmp_path):
    from tarscribe_backend.live_audio import build_wav_window, validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x00\x00" * 48000  # 3s
    validate_and_append_chunk(pcm_path, chunk, 0, 0, 16000, 1)

    out = tmp_path / "window.wav"
    ok = build_wav_window(pcm_path, 1.0, 2.0, 16000, 1, out)
    assert ok
    assert out.exists()

    import wave

    with wave.open(str(out)) as wf:
        assert wf.getnchannels() == 1
        assert wf.getframerate() == 16000
        assert abs(wf.getnframes() / 16000 - 1.0) < 0.01


def test_chunk_mismatched_audio_format_rejected(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = client.post(
        f"/api/live-recordings/{sid}/chunks",
        content=_make_pcm_chunk(),
        headers={
            "Content-Type": "application/octet-stream",
            "X-Sequence-Number": "0",
            "X-Sample-Rate": "44100",
            "X-Channels": "1",
        },
    )
    assert r.status_code == 422


def test_finish_with_unknown_recording_id_rejected(client):
    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]

    r = client.post(f"/api/live-recordings/{sid}/finish", json={"recording_id": 99999})
    assert r.status_code == 404
    # Session must stay active so a finish with the real recording can follow.
    assert client.get(f"/api/live-recordings/{sid}").json()["status"] == "recording"

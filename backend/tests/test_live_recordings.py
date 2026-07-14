"""Tests for live recording session lifecycle and PCM chunk handling."""

from __future__ import annotations

import importlib
import json
import tempfile

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
    la._service = None

    import tarscribe_backend.jobs as jobs

    queued_asr_jobs: list[tuple[int, str | None]] = []

    def fake_enqueue_asr(recording_id: int, override: str | None = None) -> int:
        queued_asr_jobs.append((recording_id, override))
        return 1000 + len(queued_asr_jobs) - 1

    monkeypatch.setattr(jobs, "enqueue_asr", fake_enqueue_asr)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    test_client = TestClient(main.create_app())
    test_client.queued_asr_jobs = queued_asr_jobs
    return test_client


# ── Helper to create a topic ────────────────────────────────────────────────

def _make_topic(client, name="Test") -> int:
    r = client.post("/api/topics", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _make_pcm_chunk(num_samples: int = 32000, channels: int = 1) -> bytes:
    """Return silent PCM16 data."""
    return b"\x00\x00" * num_samples * channels


def _make_recording(topic_id: int) -> int:
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, RecordingStatus

    with Session(db.get_engine()) as s:
        rec = Recording(
            topic_id=topic_id,
            title="Live Ziel",
            audio_path="/tmp/missing-live.wav",
            status=RecordingStatus.uploaded,
        )
        s.add(rec)
        s.commit()
        return rec.id


def _set_live_snapshot(session_id: str, words: list[dict]) -> None:
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import LiveRecordingSession

    with Session(db.get_engine()) as s:
        live = s.get(LiveRecordingSession, session_id)
        assert live is not None
        live.transcript_snapshot_json = json.dumps(
            {"revision": 3, "duration_sec": 1.0, "words": words}
        )
        s.add(live)
        s.commit()


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
    assert r.json()["transcription_job_id"] is None

    r2 = client.get(f"/api/live-recordings/{sid}")
    assert r2.json()["status"] == "completed"


def test_finish_persists_live_transcript_snapshot(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, RecordingStatus

    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    recording_id = _make_recording(topic_id)
    _set_live_snapshot(
        sid,
        [
            {"start": 0.0, "end": 0.4, "text": "Hallo ", "confidence": 0.9},
            {"start": 0.4, "end": 0.8, "text": "Welt", "confidence": 0.8},
        ],
    )

    r = client.post(f"/api/live-recordings/{sid}/finish", json={"recording_id": recording_id})
    assert r.status_code == 200
    assert r.json()["transcription_job_id"] == 1000
    assert client.queued_asr_jobs == [(recording_id, None)]

    tr = client.get(f"/api/recordings/{recording_id}/transcript")
    assert tr.status_code == 200
    body = tr.json()
    assert body["asr_model"] == "live"
    assert body["text"] == "Hallo Welt"
    assert [w["text"] for w in body["words"]] == ["Hallo ", "Welt"]

    with Session(db.get_engine()) as s:
        assert s.get(Recording, recording_id).status == RecordingStatus.ready


def test_finish_does_not_overwrite_existing_transcript_words(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Transcript, Word

    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    recording_id = _make_recording(topic_id)
    with Session(db.get_engine()) as s:
        transcript = Transcript(recording_id=recording_id, asr_model="final-asr")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Final"))
        s.commit()
    _set_live_snapshot(
        sid,
        [{"start": 0.0, "end": 0.4, "text": "Live", "confidence": 0.9}],
    )

    r = client.post(f"/api/live-recordings/{sid}/finish", json={"recording_id": recording_id})
    assert r.status_code == 200

    tr = client.get(f"/api/recordings/{recording_id}/transcript")
    assert tr.status_code == 200
    assert tr.json()["asr_model"] == "final-asr"
    assert tr.json()["text"] == "Final"


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
    assert body["live_speaker_matching_enabled"] is True


def test_live_transcription_enabled_flag_can_be_disabled(client):
    r = client.put("/api/settings", json={"live_transcription_enabled": False})
    assert r.status_code == 200
    assert r.json()["live_transcription_enabled"] is False


def test_live_speaker_preferences_can_be_disabled_independently(client):
    r = client.put(
        "/api/settings",
        json={
            "live_speaker_detection_enabled": False,
            "live_speaker_matching_enabled": False,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["live_speaker_detection_enabled"] is False
    assert body["live_speaker_matching_enabled"] is False


def test_live_diarization_tick_does_no_model_work_when_disabled(client, monkeypatch, tmp_path):
    import tarscribe_backend.live_analysis as live_analysis
    import tarscribe_backend.ml.live_diarization as live_diarization

    client.put("/api/settings", json={"live_speaker_detection_enabled": False})
    monkeypatch.setattr(
        live_diarization,
        "run_window",
        lambda **kwargs: pytest.fail(
            "Live-Diarisierung wurde trotz deaktivierter Option ausgeführt"
        ),
    )

    service = live_analysis.LiveAnalysisService()
    result = service._diarization_tick("session", tmp_path / "audio.pcm", 10, 16000, 1)

    assert result is None


def test_disabling_live_diarization_clears_active_live_speakers(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.live_analysis as live_analysis
    import tarscribe_backend.ml.live_asr as live_asr
    from tarscribe_backend.models import LiveRecordingSession

    topic_id = _make_topic(client)
    sid = client.post("/api/live-recordings", json={"topic_id": topic_id}).json()["id"]
    assert _upload_chunk(client, sid, 0, _make_pcm_chunk()).status_code == 200
    with Session(db.get_engine()) as session:
        live = session.get(LiveRecordingSession, sid)
        live.speaker_snapshot_json = json.dumps(
            {
                "revision": 2,
                "speakers": [
                    {
                        "id": "live-speaker-1",
                        "display_name": "Valentino",
                        "known_speaker_id": 7,
                        "similarity": 0.91,
                        "match_status": "probable",
                    }
                ],
            }
        )
        session.add(live)
        session.commit()

    client.put("/api/settings", json={"live_speaker_detection_enabled": False})
    monkeypatch.setattr(
        live_asr,
        "analyze_window",
        lambda **kwargs: [
            {
                "id": "w1",
                "start": 1.2,
                "end": 1.8,
                "text": "Hallo",
                "confidence": 0.9,
                "is_final": True,
                "speaker_id": "live-speaker-1",
            }
        ],
    )

    service = live_analysis.LiveAnalysisService()
    try:
        service._analyze(sid)
    finally:
        service._executor.shutdown(wait=True)

    live = client.get(f"/api/live-recordings/{sid}").json()
    transcript_snapshot = json.loads(live["transcript_snapshot_json"])
    speaker_snapshot = json.loads(live["speaker_snapshot_json"])
    assert transcript_snapshot["speaker_detection_enabled"] is False
    assert transcript_snapshot["words"][0]["speaker_id"] is None
    assert speaker_snapshot["speakers"] == []


def test_live_speaker_matching_does_no_matching_work_when_disabled(client, monkeypatch, tmp_path):
    import tarscribe_backend.live_analysis as live_analysis
    import tarscribe_backend.ml.live_diarization as live_diarization
    import tarscribe_backend.ml.lifecycle as lifecycle

    class LockStub:
        def acquire(self, timeout):
            return True

        def release(self):
            return None

    client.put(
        "/api/settings",
        json={
            "live_speaker_detection_enabled": True,
            "live_speaker_matching_enabled": False,
        },
    )
    state = live_diarization.DiarizationState()
    cluster = state.new_cluster()
    cluster.display_name = "Valentino"
    cluster.known_speaker_id = 7
    cluster.similarity = 0.91
    cluster.match_status = "probable"
    cluster.consecutive_matches = 2
    monkeypatch.setattr(live_diarization, "run_window", lambda **kwargs: state)
    monkeypatch.setattr(lifecycle, "diar_lock", LockStub())
    monkeypatch.setattr(
        live_diarization,
        "match_known_speakers",
        lambda **kwargs: pytest.fail(
            "Live-Speaker-Matching wurde trotz deaktivierter Option ausgeführt"
        ),
    )

    service = live_analysis.LiveAnalysisService()
    service._diar_backend = type("DiarizationBackendStub", (), {"diarize": lambda *args: []})()
    result = service._diarization_tick("session", tmp_path / "audio.pcm", 10, 16000, 1)

    assert result is state
    assert cluster.display_name == "Sprecher 1"
    assert cluster.known_speaker_id is None
    assert cluster.similarity is None
    assert cluster.match_status == "none"


def test_recording_source_defaults_to_microphone_and_accepts_native_modes(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["recording_source"] == "microphone"

    r = client.put("/api/settings", json={"recording_source": "system_audio_and_microphone"})
    assert r.status_code == 200
    assert r.json()["recording_source"] == "system_audio_and_microphone"


def test_live_speaker_snapshot_only_lists_speakers_present_in_words():
    from tarscribe_backend.live_analysis import _speaker_snapshot_from_words
    from tarscribe_backend.ml.live_diarization import DiarizationState

    state = DiarizationState()
    valentino = state.new_cluster()
    extra = state.new_cluster()
    valentino.display_name = "Valentino"
    extra.display_name = "Sprecher ohne Text"

    snapshot = _speaker_snapshot_from_words(
        state,
        [
            {"text": "Hallo", "speaker_id": valentino.id},
            {"text": ".", "speaker_id": None},
        ],
        revision=7,
    )

    assert snapshot["revision"] == 7
    assert [speaker["display_name"] for speaker in snapshot["speakers"]] == ["Valentino"]


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


# ── audio_utils module unit tests ────────────────────────────────────────────

def test_validate_append_first_chunk(tmp_path):
    from tarscribe_backend.audio_utils import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x01\x00" * 16000  # 1s mono PCM16
    result = validate_and_append_chunk(pcm_path, chunk, 0, 0, 16000, 1)
    assert result.accepted
    assert result.last_sequence_number == 0
    assert abs(result.received_duration_sec - 1.0) < 0.01
    assert pcm_path.exists()


def test_validate_append_idempotent(tmp_path):
    from tarscribe_backend.audio_utils import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x00\x00" * 8000
    validate_and_append_chunk(pcm_path, chunk, 0, 0, 16000, 1)
    result = validate_and_append_chunk(pcm_path, chunk, 0, 1, 16000, 1)
    assert result.accepted
    assert result.reason == "already_processed"


def test_validate_append_gap(tmp_path):
    from tarscribe_backend.audio_utils import validate_and_append_chunk

    pcm_path = tmp_path / "audio.pcm"
    chunk = b"\x00\x00" * 8000
    result = validate_and_append_chunk(pcm_path, chunk, 2, 0, 16000, 1)
    assert not result.accepted
    assert "gap" in result.reason


def test_build_wav_window(tmp_path):
    from tarscribe_backend.audio_utils import build_wav_window, validate_and_append_chunk

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


def test_legacy_live_audio_endpoint_is_gone(client):
    assert client.get("/api/live-audio").status_code == 410
    assert client.post("/api/live-audio/chunks", content=b"\x00\x00").status_code == 410

"""End-to-end smoke tests against the FastAPI app using a temp data dir."""

from __future__ import annotations

import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")  # disable auth in tests

    # Import after env is set so cached settings pick up the temp dir.
    import importlib

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


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_waveform_endpoint_returns_and_reuses_bounded_peaks(client, monkeypatch):
    import numpy as np
    import soundfile as sf
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.routers.recordings as recordings_router
    from tarscribe_backend.config import get_settings
    from tarscribe_backend.models import Recording, Topic

    audio_path = get_settings().audio_dir / "waveform-test.wav"
    samples = np.linspace(-0.75, 0.75, 400, dtype=np.float32)
    sf.write(audio_path, samples, 8000, subtype="PCM_16")

    with Session(db.get_engine()) as session:
        topic = Topic(name="Waveform")
        session.add(topic)
        session.flush()
        recording = Recording(
            topic_id=topic.id,
            title="Lange Aufnahme",
            audio_path=str(audio_path),
            duration_sec=0.05,
        )
        session.add(recording)
        session.commit()
        recording_id = recording.id

    response = client.get(f"/api/recordings/{recording_id}/waveform?points=200")
    assert response.status_code == 200
    body = response.json()
    assert body["duration_sec"] == pytest.approx(0.05)
    assert len(body["peaks"]) == 400
    assert max(body["peaks"]) <= 1.0
    assert min(body["peaks"]) >= -1.0
    cache_dir = recordings_router.get_settings().waveforms_dir
    assert len(list(cache_dir.glob(f"{recording_id}-*.json"))) == 1

    monkeypatch.setattr(
        recordings_router,
        "compute_waveform_peaks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("cache not used")),
    )
    cached = client.get(f"/api/recordings/{recording_id}/waveform?points=200")
    assert cached.status_code == 200
    assert cached.json() == body


def test_mcp_diagnostics(client):
    r = client.get("/api/mcp/diagnostics")
    assert r.status_code == 200
    body = r.json()
    assert "connection_file" in body
    assert body["tools"]["count"] > 0
    capability_ids = {item["id"] for item in body["capabilities"]}
    assert {"context", "search", "tasks", "analysis"} <= capability_ids


def test_mcp_registration_api_is_not_exposed(client):
    assert client.post("/api/mcp/register/codex").status_code == 404
    assert client.delete("/api/mcp/register/codex").status_code == 404


def test_hardware(client):
    r = client.get("/api/system/hardware")
    assert r.status_code == 200
    body = r.json()
    assert "recommended_asr" in body
    assert "is_apple_silicon" in body
    assert "recommended_profile" in body


def test_model_status_lists_local_cache_state(client):
    r = client.get("/api/system/models")
    assert r.status_code == 200
    body = r.json()
    assert "models_dir" in body
    assert any(item["kind"] == "asr" for item in body["items"])
    assert any(item["kind"] == "diarization" for item in body["items"])
    active = [item for item in body["items"] if item["active"]]
    assert all("runtime_memory_min_gb" in item for item in active)
    assert any(item["kind"] == "embedding" and item["active"] for item in body["items"])


def test_model_status_disables_speaker_matching_memory_for_small_profile(client):
    client.put("/api/settings", json={"performance_profile": "m1_8gb"})

    r = client.get("/api/system/models")
    assert r.status_code == 200
    body = r.json()
    client.put("/api/settings", json={"performance_profile": "balanced"})
    embedding = next(item for item in body["items"] if item["kind"] == "embedding")
    assert embedding["active"] is False
    assert "runtime_memory_min_gb" in embedding


def test_model_status_marks_custom_local_asr_model_downloaded(client):
    from tarscribe_backend.config import get_settings

    local_model = get_settings().models_dir / "local-whisper"
    local_model.mkdir(parents=True)
    (local_model / "config.json").write_text("{}")

    client.put(
        "/api/settings",
        json={"asr_override": "faster-whisper", "asr_model": str(local_model)},
    )

    r = client.get("/api/system/models")
    assert r.status_code == 200
    active = next(item for item in r.json()["items"] if item["kind"] == "asr" and item["active"])
    assert active["model"] == str(local_model)
    assert active["downloaded"] is True
    assert active["path"] == str(local_model)


def test_settings_performance_profile(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["performance_profile"] == "balanced"

    r = client.put("/api/settings", json={"performance_profile": "m1_8gb"})
    assert r.status_code == 200
    assert r.json()["performance_profile"] == "m1_8gb"


def test_topic_crud(client):
    r = client.post("/api/topics", json={"name": "Uni", "color": "#ff0000"})
    assert r.status_code == 201
    topic = r.json()
    assert topic["name"] == "Uni"

    r = client.get("/api/topics")
    assert r.status_code == 200
    overview = next(t for t in r.json() if t["id"] == topic["id"])
    assert overview["recording_count"] == 0
    assert overview["transcribed_count"] == 0
    assert overview["diarized_count"] == 0
    assert overview["exported_count"] == 0

    r = client.patch(f"/api/topics/{topic['id']}", json={"name": "Universität"})
    assert r.json()["name"] == "Universität"

    r = client.delete(f"/api/topics/{topic['id']}")
    assert r.status_code == 204


def test_topic_reorder_persists_arrangement(client):
    ids = [
        client.post("/api/topics", json={"name": name}).json()["id"]
        for name in ("Alpha", "Beta", "Gamma")
    ]
    # New topics keep creation order in the sidebar.
    listed = [t["id"] for t in client.get("/api/topics").json()]
    assert listed == ids

    # Move the last topic to the front.
    new_order = [ids[2], ids[0], ids[1]]
    r = client.post("/api/topics/reorder", json={"order": new_order})
    assert r.status_code == 204

    listed = client.get("/api/topics").json()
    assert [t["id"] for t in listed] == new_order
    assert [t["position"] for t in listed] == [0, 1, 2]

    # A partial order lists named ids first; the rest keep their relative order.
    r = client.post("/api/topics/reorder", json={"order": [ids[1]]})
    assert r.status_code == 204
    listed = [t["id"] for t in client.get("/api/topics").json()]
    assert listed[0] == ids[1]
    assert listed[1:] == [ids[2], ids[0]]


def test_chat_sessions_persist_messages_and_scope(client):
    global_chat = client.post("/api/chats", json={"scope": "global"}).json()
    assert global_chat["title"] == "Neuer Chat"
    assert global_chat["messages"] == []

    r = client.post(
        f"/api/chats/{global_chat['id']}/messages",
        json={"role": "user", "content": "Was wurde beschlossen?"},
    )
    assert r.status_code == 201
    client.post(
        f"/api/chats/{global_chat['id']}/messages",
        json={
            "role": "assistant",
            "content": "Es gab eine Entscheidung. [1]",
            "sources": [
                {
                    "index": 1,
                    "recording_id": None,
                    "recording_title": "Handbuch",
                    "topic_id": None,
                    "source_type": "document",
                    "text": "Entscheidung",
                }
            ],
        },
    )

    loaded = client.get(f"/api/chats/{global_chat['id']}").json()
    assert loaded["title"] == "Was wurde beschlossen?"
    assert loaded["message_count"] == 2
    assert loaded["messages"][1]["sources"][0]["recording_title"] == "Handbuch"

    topic = client.post("/api/topics", json={"name": "Projekt"}).json()
    from sqlmodel import Session

    from tarscribe_backend.db import get_engine
    from tarscribe_backend.models import Recording

    with Session(get_engine()) as s:
        rec = Recording(topic_id=topic["id"], title="Jour fixe", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.commit()
        s.refresh(rec)
        recording_id = rec.id

    recording_chat = client.post(
        "/api/chats",
        json={"scope": "recording", "recording_id": recording_id},
    ).json()
    assert recording_chat["topic_id"] == topic["id"]

    global_list = client.get("/api/chats?scope=global").json()
    recording_list = client.get(f"/api/chats?scope=recording&recording_id={recording_id}").json()
    assert [c["id"] for c in global_list] == [global_chat["id"]]
    assert [c["id"] for c in recording_list] == [recording_chat["id"]]

    r = client.delete(f"/api/chats/{global_chat['id']}")
    assert r.status_code == 204
    assert client.get(f"/api/chats/{global_chat['id']}").status_code == 404


def test_rag_chat_uses_per_request_reasoning_effort(client, monkeypatch):
    import tarscribe_backend.routers.rag as rag_router

    captured: dict = {}

    monkeypatch.setattr(rag_router.R, "rag_enabled", lambda: True)
    monkeypatch.setattr(
        rag_router.R,
        "search",
        lambda *_args, **_kwargs: [
            {
                "recording_id": None,
                "recording_title": "Handbuch",
                "topic_id": None,
                "document_id": None,
                "source_type": "document",
                "start_sec": None,
                "end_sec": None,
                "speaker": None,
                "text": "Die Antwort steht im Handbuch.",
            }
        ],
    )
    monkeypatch.setattr(
        rag_router.L,
        "get_llm_config",
        lambda: {
            "model": "local-test",
            "base_url": "http://llm",
            "reasoning_effort": "low",
        },
    )

    def fake_stream_chat(*_args, **kwargs):
        captured.update(kwargs)
        yield "Antwort"

    monkeypatch.setattr(rag_router.L, "stream_chat", fake_stream_chat)

    r = client.post(
        "/api/rag/chat",
        json={
            "messages": [{"role": "user", "content": "Was gilt?"}],
            "reasoning_effort": "high",
        },
    )

    assert r.status_code == 200
    assert "Antwort" in r.text
    assert captured["reasoning_effort"] == "high"


def test_topic_overview_counts_artifacts_and_exports(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import DiarizationRun, Recording, Topic, Transcript, Word

    with Session(db.get_engine()) as s:
        topic = Topic(name="Vorlesung")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Termin 1", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        transcript = Transcript(recording_id=rec.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        s.add(DiarizationRun(recording_id=rec.id, model="test"))
        s.commit()
        topic_id = topic.id
        recording_id = rec.id

    r = client.get("/api/topics")
    assert r.status_code == 200
    overview = next(t for t in r.json() if t["id"] == topic_id)
    assert overview["recording_count"] == 1
    assert overview["transcribed_count"] == 1
    assert overview["diarized_count"] == 1
    assert overview["exported_count"] == 0

    r = client.get(f"/api/recordings/{recording_id}/export?format=txt")
    assert r.status_code == 200

    r = client.get("/api/topics")
    overview = next(t for t in r.json() if t["id"] == topic_id)
    assert overview["exported_count"] == 1


def test_recording_can_move_between_topics(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, Topic

    with Session(db.get_engine()) as s:
        source = Topic(name="Meetings")
        target = Topic(name="Projekt")
        s.add(source)
        s.add(target)
        s.flush()
        rec = Recording(topic_id=source.id, title="Weekly", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.commit()
        source_id = source.id
        target_id = target.id
        recording_id = rec.id

    r = client.patch(f"/api/recordings/{recording_id}", json={"topic_id": target_id})
    assert r.status_code == 200
    assert r.json()["topic_id"] == target_id

    by_id = {topic["id"]: topic for topic in client.get("/api/topics").json()}
    assert by_id[source_id]["recording_count"] == 0
    assert by_id[target_id]["recording_count"] == 1

    r = client.patch(f"/api/recordings/{recording_id}", json={"topic_id": 99999})
    assert r.status_code == 404


def test_empty_transcript_row_is_not_returned_as_transcript(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, Topic, Transcript

    with Session(db.get_engine()) as s:
        topic = Topic(name="Leeres Transkript")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Leer", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        s.add(Transcript(recording_id=rec.id, asr_model="broken-live"))
        s.commit()
        recording_id = rec.id

    r = client.get(f"/api/recordings/{recording_id}/transcript")
    assert r.status_code == 404


def test_builtin_templates_seeded(client):
    # Built-in summary templates should be present after init.
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import SummaryTemplate

    with Session(db.get_engine()) as s:
        rows = s.exec(select(SummaryTemplate)).all()
    names = {t.name for t in rows}
    assert len(rows) >= 4
    # The standalone tasks template was retired in favour of the action-items feature.
    assert "Action Items / To-dos" not in names


def test_seed_prunes_obsolete_builtin_template(client):
    # An obsolete built-in template is removed on re-seed; summaries that
    # referenced it keep their content but lose the dangling template link.
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, Summary, SummaryTemplate, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Alt")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Alt", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        stale = SummaryTemplate(name="Action Items / To-dos", is_builtin=True)
        s.add(stale)
        s.flush()
        summary = Summary(recording_id=rec.id, template_id=stale.id, model="", content="x")
        s.add(summary)
        s.commit()
        summary_id = summary.id

    db._seed_builtin_templates()

    with Session(db.get_engine()) as s:
        names = {t.name for t in s.exec(select(SummaryTemplate)).all()}
        assert "Action Items / To-dos" not in names
        kept = s.get(Summary, summary_id)
        assert kept is not None
        assert kept.template_id is None


def test_known_speaker_list_merges_duplicate_names(client):
    import numpy as np
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.ml.embedding import to_blob
    from tarscribe_backend.models import KnownSpeaker, Recording, SpeakerLabel, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Stimmen")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Interview", audio_path="/tmp/missing.wav")
        s.add(rec)
        s.flush()
        first = KnownSpeaker(
            name="Ada",
            embedding_blob=to_blob(np.array([1.0, 0.0], dtype=np.float32)),
            sample_count=1,
        )
        duplicate = KnownSpeaker(
            name="Ada",
            embedding_blob=to_blob(np.array([0.0, 1.0], dtype=np.float32)),
            sample_count=2,
        )
        s.add(first)
        s.add(duplicate)
        s.flush()
        s.add(
            SpeakerLabel(
                recording_id=rec.id,
                original_label="SPEAKER_01",
                display_name=duplicate.name,
                known_speaker_id=duplicate.id,
            )
        )
        s.commit()
        first_id = first.id
        duplicate_id = duplicate.id

    r = client.get("/api/known-speakers")
    assert r.status_code == 200
    speakers = [s for s in r.json() if s["name"] == "Ada"]
    assert speakers == [{"id": first_id, "name": "Ada", "color": "#10b981", "sample_count": 3}]

    with Session(db.get_engine()) as s:
        assert s.get(KnownSpeaker, duplicate_id) is None
        label = s.exec(select(SpeakerLabel).where(SpeakerLabel.original_label == "SPEAKER_01")).one()
        assert label.known_speaker_id == first_id
        assert label.display_name == "Ada"


def test_known_speaker_rename_merges_same_name(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import KnownSpeaker

    with Session(db.get_engine()) as s:
        first = KnownSpeaker(name="Sam", sample_count=1)
        second = KnownSpeaker(name="Taylor", sample_count=4)
        s.add(first)
        s.add(second)
        s.commit()
        first_id = first.id
        second_id = second.id

    r = client.patch(f"/api/known-speakers/{second_id}", json={"name": "Sam"})
    assert r.status_code == 200
    assert r.json()["id"] == second_id
    assert r.json()["name"] == "Sam"
    assert r.json()["sample_count"] == 5

    with Session(db.get_engine()) as s:
        assert s.get(KnownSpeaker, first_id) is None
        assert s.get(KnownSpeaker, second_id).sample_count == 5


def test_import_local_recording_accepts_native_capture_file(client, monkeypatch):
    from pathlib import Path

    import tarscribe_backend.routers.recordings as recordings
    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = recordings.get_settings().native_recordings_dir / "capture.caf"
    source.write_bytes(b"caf")

    def fake_normalize(src: Path, dst: Path) -> None:
        dst.write_bytes(src.read_bytes())

    monkeypatch.setattr(recordings, "normalize_to_wav", fake_normalize)
    monkeypatch.setattr(recordings, "probe_duration", lambda _path: 3.5)

    r = client.post(
        "/api/recordings/import-local",
        json={"topic_id": topic["id"], "title": "Systemaudio", "path": str(source)},
    )
    assert r.status_code == 201
    assert r.json()["title"] == "Systemaudio"
    assert r.json()["duration_sec"] == 3.5
    assert not source.exists()


def test_import_local_recording_rejects_files_outside_native_capture_dir(client, tmp_path):
    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = tmp_path / "outside.caf"
    source.write_bytes(b"caf")

    r = client.post(
        "/api/recordings/import-local",
        json={"topic_id": topic["id"], "path": str(source)},
    )
    assert r.status_code == 403


def test_import_local_mixed_recording_combines_system_audio_and_microphone(client, monkeypatch):
    from pathlib import Path

    import tarscribe_backend.routers.recordings as recordings

    topic = client.post("/api/topics", json={"name": "Native"}).json()
    source = recordings.get_settings().native_recordings_dir / "capture.caf"
    source.write_bytes(b"system")

    def fake_mix(system_audio: Path, microphone_audio: Path, dst: Path) -> None:
        dst.write_bytes(system_audio.read_bytes() + b"+" + microphone_audio.read_bytes())

    monkeypatch.setattr(recordings, "mix_to_wav", fake_mix)
    monkeypatch.setattr(recordings, "probe_duration", lambda _path: 4.0)

    r = client.post(
        "/api/recordings/import-local-mixed",
        data={"topic_id": topic["id"], "title": "Gemischt", "path": str(source)},
        files={"microphone": ("microphone.webm", b"microphone", "audio/webm")},
    )
    assert r.status_code == 201
    assert r.json()["title"] == "Gemischt"
    assert r.json()["duration_sec"] == 4.0
    assert not source.exists()


def test_delete_recording_removes_dependent_rows_even_when_audio_is_missing(client):
    from pathlib import Path

    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        DiarizationRun,
        Job,
        JobPhase,
        JobStatus,
        ManualEdit,
        Recording,
        Segment,
        SpeakerLabel,
        Summary,
        Topic,
        Transcript,
        Word,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Defekt", audio_path="/tmp/missing-tarscribe.wav")
        s.add(rec)
        s.flush()
        transcript = Transcript(recording_id=rec.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        run = DiarizationRun(recording_id=rec.id, model="test")
        s.add(run)
        s.flush()
        s.add(Segment(run_id=run.id, start=0, end=1, speaker_label="SPEAKER_00"))
        s.add(SpeakerLabel(recording_id=rec.id, original_label="SPEAKER_00"))
        s.add(ManualEdit(recording_id=rec.id, edit_type="rename"))
        s.add(Summary(recording_id=rec.id, model="test"))
        s.add(Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.done))
        s.commit()
        recording_id = rec.id

    assert not Path("/tmp/missing-tarscribe.wav").exists()
    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 204

    with Session(db.get_engine()) as s:
        assert s.get(Recording, recording_id) is None
        assert not s.exec(select(Job).where(Job.recording_id == recording_id)).all()
        assert not s.exec(select(Transcript).where(Transcript.recording_id == recording_id)).all()
        assert not s.exec(select(DiarizationRun).where(DiarizationRun.recording_id == recording_id)).all()


def test_delete_recording_with_finalized_live_session(client):
    """Deleting a recording that has a linked LiveRecordingSession must succeed."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import LiveRecordingSession, LiveSessionStatus, Recording, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Live", audio_path="/tmp/live-test.wav")
        s.add(rec)
        s.flush()
        live = LiveRecordingSession(
            id="abc123",
            topic_id=topic.id,
            title="Live",
            status=LiveSessionStatus.completed,
            pcm_path="/tmp/live.pcm",
            finalized_recording_id=rec.id,
        )
        s.add(live)
        s.commit()
        recording_id = rec.id

    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 204

    with Session(db.get_engine()) as s:
        assert s.get(Recording, recording_id) is None
        assert s.get(LiveRecordingSession, "abc123") is None


def test_delete_recording_rejects_running_job(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title="Aktiv", audio_path="/tmp/active-tarscribe.wav")
        s.add(rec)
        s.flush()
        s.add(Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.running))
        s.commit()
        recording_id = rec.id

    r = client.delete(f"/api/recordings/{recording_id}")
    assert r.status_code == 409


def test_global_jobs_list_and_cancel(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Job, JobPhase, JobStatus, Recording, RecordingStatus, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Debug")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="Laufender Auftrag",
            audio_path="/tmp/job.wav",
            status=RecordingStatus.transcribing,
        )
        s.add(rec)
        s.flush()
        running = Job(
            recording_id=rec.id,
            phase=JobPhase.asr,
            status=JobStatus.running,
            progress=0.42,
        )
        done = Job(recording_id=rec.id, phase=JobPhase.chapters, status=JobStatus.done)
        s.add(running)
        s.add(done)
        s.commit()
        running_id = running.id
        done_id = done.id

    r = client.get("/api/jobs")
    assert r.status_code == 200
    rows = r.json()
    assert [row["job_id"] for row in rows] == [running_id]
    assert rows[0]["recording_title"] == "Laufender Auftrag"
    assert rows[0]["topic_name"] == "Debug"
    assert rows[0]["progress"] == 0.42

    canceled = client.post(f"/api/jobs/{running_id}/cancel")
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"
    assert client.get("/api/jobs").json() == []

    rejected = client.post(f"/api/jobs/{done_id}/cancel")
    assert rejected.status_code == 409
    missing = client.post("/api/jobs/999999/cancel")
    assert missing.status_code == 404

    with Session(db.get_engine()) as s:
        assert s.get(Job, running_id).status == JobStatus.canceled
        assert s.get(Job, done_id).status == JobStatus.done
        assert s.get(Recording, rows[0]["recording_id"]).status == RecordingStatus.uploaded


def test_summary_runner_persists_streamed_content_and_exposes_it_via_api(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        Summary,
        SummaryTemplate,
        Topic,
        Transcript,
        Word,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        recording = Recording(topic_id=topic.id, title="Stream", audio_path="/tmp/stream.wav")
        s.add(recording)
        s.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        template = SummaryTemplate(name="Test", user_prompt_template="{{transcript}}")
        s.add(template)
        s.flush()
        summary = Summary(recording_id=recording.id, template_id=template.id, model="")
        s.add(summary)
        job = Job(recording_id=recording.id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.commit()
        recording_id = recording.id
        template_id = template.id
        summary_id = summary.id
        job_id = job.id

    events = []
    monkeypatch.setattr(llm, "get_llm_config", lambda: {"model": "local-test", "base_url": "http://llm"})
    async def fake_astream_chat(*_args, **_kwargs):
        for delta in ("Hallo", " Welt"):
            yield delta

    monkeypatch.setattr(llm, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(jobs.hub, "broadcast", events.append)

    jobs._run_summary(recording_id, job_id, template_id, summary_id)

    r = client.get(f"/api/summaries/{summary_id}")
    assert r.status_code == 200
    assert r.json()["content"] == "Hallo Welt\n\n## Aufgaben\n\nKeine Aufgaben erkannt."
    job_payload = client.get(f"/api/recordings/{recording_id}/jobs").json()[0]
    assert job_payload["job_id"] == job_id
    assert "id" not in job_payload
    assert any(event.get("type") == "summary" and event.get("delta") == "Hallo" for event in events)
    assert any(event.get("type") == "summary" and event.get("done") is True for event in events)

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.done


def test_summary_appends_separately_extracted_tasks_without_sending_them_to_summary_llm(
    client, monkeypatch
):
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import (
        ActionItem,
        Job,
        JobPhase,
        JobStatus,
        Recording,
        Summary,
        SummaryTemplate,
        Topic,
        Transcript,
        Word,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Test")
        s.add(topic)
        s.flush()
        recording = Recording(topic_id=topic.id, title="Aufgaben", audio_path="/tmp/tasks.wav")
        s.add(recording)
        s.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(
            Word(
                transcript_id=transcript.id,
                idx=0,
                start=0,
                end=1,
                text="Anna schreibt den Bericht bis Freitag.",
            )
        )
        template = SummaryTemplate(name="Test", user_prompt_template="{{transcript}}")
        s.add(template)
        s.flush()
        summary = Summary(recording_id=recording.id, template_id=template.id, model="")
        s.add(summary)
        job = Job(recording_id=recording.id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.commit()
        recording_id = recording.id
        template_id = template.id
        summary_id = summary.id
        job_id = job.id

    summary_messages: list[list[dict]] = []

    async def fake_astream_chat(messages, *_args, **_kwargs):
        if "JSON-Array" in messages[0]["content"]:
            yield (
                '[{"kind":"task","text":"Bericht schreiben","assignee":"Anna",'
                '"due":"bis Freitag","due_date":null}]'
            )
            return
        summary_messages.append(messages)
        yield "Nur die Zusammenfassung."

    monkeypatch.setattr(
        llm,
        "get_llm_config",
        lambda: {"model": "local-test", "base_url": "http://llm"},
    )
    monkeypatch.setattr(llm, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(jobs.hub, "broadcast", lambda *_args, **_kwargs: None)

    jobs._run_summary(recording_id, job_id, template_id, summary_id)

    with Session(db.get_engine()) as s:
        content = s.get(Summary, summary_id).content
        items = list(s.exec(select(ActionItem).where(ActionItem.recording_id == recording_id)))

    assert summary_messages
    assert all("Bericht schreiben" not in message["content"] for message in summary_messages[0])
    assert content == (
        "Nur die Zusammenfassung.\n\n"
        "## Aufgaben\n\n"
        "- [ ] Bericht schreiben — Anna, bis Freitag"
    )
    assert [item.text for item in items] == ["Bericht schreiben"]


def test_meeting_protocol_prompt_treats_topic_as_context(client, monkeypatch):
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        Summary,
        SummaryTemplate,
        Topic,
        Transcript,
        Word,
    )
    from tarscribe_backend.settings_store import save_prefs

    save_prefs({"summary_use_topic_knowledge": False})

    with Session(db.get_engine()) as s:
        topic = Topic(name="Euripides")
        s.add(topic)
        s.flush()
        recording = Recording(topic_id=topic.id, title="IGA Strategie", audio_path="/tmp/iga.wav")
        s.add(recording)
        s.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        s.add(transcript)
        s.flush()
        for idx, text in enumerate(
            "Strategie und Taktik fuer das Treffen mit der IGA Leitung".split()
        ):
            s.add(Word(transcript_id=transcript.id, idx=idx, start=idx, end=idx + 0.5, text=text + " "))
        template = s.exec(
            select(SummaryTemplate).where(SummaryTemplate.name == "Meeting-Protokoll")
        ).one()
        summary = Summary(recording_id=recording.id, template_id=template.id, model="")
        s.add(summary)
        job = Job(recording_id=recording.id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.commit()
        recording_id = recording.id
        template_id = template.id
        summary_id = summary.id
        job_id = job.id

    seen: dict[str, list[dict]] = {}

    async def fake_astream_chat(messages, *_args, **_kwargs):
        seen["messages"] = messages
        yield "ok"

    monkeypatch.setattr(llm, "get_llm_config", lambda: {"model": "local-test", "base_url": "http://llm"})
    monkeypatch.setattr(llm, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(jobs.hub, "broadcast", lambda *_args, **_kwargs: None)

    jobs._run_summary(recording_id, job_id, template_id, summary_id)

    user_prompt = seen["messages"][1]["content"]
    assert "Aufnahme «IGA Strategie»" in user_prompt
    assert "Themenbereich/Ablage: «Euripides»" in user_prompt
    assert "kein Suchauftrag" in user_prompt
    assert "für das Thema «Euripides»" not in user_prompt


def test_stale_jobs_failed_on_startup(client):
    """Jobs left pending/running by a crashed backend are failed on init."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        RecordingStatus,
        Topic,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Crash")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="Unterbrochen",
            audio_path="/tmp/missing.wav",
            status=RecordingStatus.transcribing,
        )
        s.add(rec)
        s.flush()
        stuck = Job(recording_id=rec.id, phase=JobPhase.asr, status=JobStatus.running)
        queued = Job(recording_id=rec.id, phase=JobPhase.summarize, status=JobStatus.pending)
        done = Job(recording_id=rec.id, phase=JobPhase.diarization, status=JobStatus.done)
        s.add(stuck)
        s.add(queued)
        s.add(done)
        s.commit()
        rec_id, stuck_id, queued_id, done_id = rec.id, stuck.id, queued.id, done.id

    db._mark_stale_jobs()  # what init_db runs on the next startup

    with Session(db.get_engine()) as s:
        assert s.get(Job, stuck_id).status == JobStatus.failed
        assert s.get(Job, queued_id).status == JobStatus.failed
        assert s.get(Job, done_id).status == JobStatus.done
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def _setup_diarization_job(with_transcript: bool):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        RecordingStatus,
        Topic,
        Transcript,
    )

    with Session(db.get_engine()) as s:
        topic = Topic(name="Dia")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="X",
            audio_path="/tmp/missing.wav",
            status=RecordingStatus.uploaded,
        )
        s.add(rec)
        s.flush()
        if with_transcript:
            s.add(Transcript(recording_id=rec.id, asr_model="test"))
        job = Job(recording_id=rec.id, phase=JobPhase.diarization, status=JobStatus.pending)
        s.add(job)
        s.commit()
        return rec.id, job.id


def test_diarization_failure_without_transcript_marks_failed(client, monkeypatch):
    """A failed diarization on a transcript-less recording must not leave it 'ready'
    (which would render a blank detail page with no way to transcribe)."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.settings_store as settings_store
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    # Force the early no-token failure so the test stays hermetic (no model load).
    monkeypatch.setattr(settings_store, "get_hf_token", lambda: None)
    rec_id, job_id = _setup_diarization_job(with_transcript=False)
    jobs._run_diarization(rec_id, job_id, {})  # raises -> failure path

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert s.get(Recording, rec_id).status == RecordingStatus.failed


def test_diarization_failure_with_transcript_stays_ready(client, monkeypatch):
    """With a transcript present, a failed (optional) diarization still leaves the
    recording usable as 'ready'."""
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.settings_store as settings_store
    from tarscribe_backend.models import Job, JobStatus, Recording, RecordingStatus

    monkeypatch.setattr(settings_store, "get_hf_token", lambda: None)
    rec_id, job_id = _setup_diarization_job(with_transcript=True)
    jobs._run_diarization(rec_id, job_id, {})

    with Session(db.get_engine()) as s:
        assert s.get(Job, job_id).status == JobStatus.failed
        assert s.get(Recording, rec_id).status == RecordingStatus.ready

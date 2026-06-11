"""Tests for action items, chapters, speaker stats, and the analysis parsers."""

from __future__ import annotations

import importlib
import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
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


def _make_recording(duration: float = 100.0):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Recording, RecordingStatus, Topic

    with Session(db.get_engine()) as s:
        topic = Topic(name="Insights")
        s.add(topic)
        s.flush()
        rec = Recording(
            topic_id=topic.id,
            title="Meeting",
            audio_path="/tmp/missing.wav",
            duration_sec=duration,
            status=RecordingStatus.ready,
        )
        s.add(rec)
        s.commit()
        return rec.id, topic.id


# ── Analysis parsing ─────────────────────────────────────────────────────────

def test_extract_json_array_tolerates_fences_and_prose():
    from tarscribe_backend.analysis import _extract_json_array

    assert _extract_json_array('Hier: ```json\n[{"a": 1}]\n```') == [{"a": 1}]
    assert _extract_json_array('[{"a": 1}] fertig') == [{"a": 1}]
    assert _extract_json_array("kein json") == []
    assert _extract_json_array('{"a": 1}') == []


def test_extract_action_items_dedupes_and_validates():
    from tarscribe_backend.analysis import extract_action_items

    def fake_chat(_msgs):
        return (
            '[{"kind": "task", "text": "Bericht schreiben", "assignee": "Anna", "due": null},'
            '{"kind": "decision", "text": "Budget freigegeben", "assignee": null, "due": null},'
            '{"kind": "task", "text": "Bericht schreiben!", "assignee": null, "due": null},'
            '{"kind": "quatsch", "text": "X klären", "assignee": null, "due": null},'
            '{"kind": "task", "text": "", "assignee": null, "due": null}]'
        )

    items = extract_action_items(fake_chat, "Transkript", ["Anna"])
    texts = [i["text"] for i in items]
    assert "Bericht schreiben" in texts
    assert "Budget freigegeben" in texts
    assert len([t for t in texts if t.lower().startswith("bericht")]) == 1  # dedupe
    assert all(i["kind"] in ("task", "decision") for i in items)


def test_generate_chapters_normalizes_and_orders():
    from dataclasses import dataclass

    from tarscribe_backend.analysis import generate_chapters

    @dataclass
    class U:
        speaker: str
        start: float
        end: float
        text: str

    utts = [U("A", float(i * 30), float(i * 30 + 25), f"Abschnitt {i}") for i in range(10)]

    def fake_chat(_msgs):
        return (
            '[{"start_sec": 150, "title": "Mitte"},'
            '{"start_sec": 5, "title": "Anfang"},'
            '{"start_sec": 152, "title": "Zu nah an Mitte"},'
            '{"start_sec": 9999, "title": "Hinter dem Ende"}]'
        )

    chapters = generate_chapters(fake_chat, utts, duration_sec=300.0)
    assert chapters[0]["start"] == 0.0  # first chapter snaps to 0
    starts = [c["start"] for c in chapters]
    assert starts == sorted(starts)
    # 152s entry dropped (within MIN_CHAPTER_GAP of 150s); 9999 clamped to 300.
    assert all(c["start"] <= 300.0 for c in chapters)
    assert chapters[-1]["end"] == 300.0


# ── Action item endpoints ────────────────────────────────────────────────────

def test_action_item_crud_and_global_list(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem

    rec_id, topic_id = _make_recording()
    with Session(db.get_engine()) as s:
        s.add(ActionItem(recording_id=rec_id, kind="task", text="Folien aktualisieren"))
        s.add(ActionItem(recording_id=rec_id, kind="decision", text="Termin verschoben", done=True))
        s.commit()

    r = client.get(f"/api/recordings/{rec_id}/action-items")
    assert r.status_code == 200
    assert len(r.json()) == 2

    r = client.get("/api/action-items")
    assert len(r.json()) == 2
    assert r.json()[0]["recording_title"] == "Meeting"
    assert r.json()[0]["topic_id"] == topic_id

    r = client.get("/api/action-items?done=false")
    assert len(r.json()) == 1
    item_id = r.json()[0]["id"]

    r = client.patch(f"/api/action-items/{item_id}", json={"done": True})
    assert r.status_code == 200
    assert r.json()["done"] is True
    assert len(client.get("/api/action-items?done=false").json()) == 0

    assert client.delete(f"/api/action-items/{item_id}").status_code == 204
    assert len(client.get("/api/action-items").json()) == 1


def test_extract_endpoint_enqueues_job(client, monkeypatch):
    import tarscribe_backend.jobs as jobs

    rec_id, _ = _make_recording()
    monkeypatch.setattr(jobs._executor, "submit", lambda *a, **k: None)
    r = client.post(f"/api/recordings/{rec_id}/action-items/extract")
    assert r.status_code == 200
    assert r.json()["job_id"] > 0


# ── Chapter endpoints ────────────────────────────────────────────────────────

def test_chapters_list_and_export(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Chapter

    rec_id, _ = _make_recording(duration=400.0)
    with Session(db.get_engine()) as s:
        s.add(Chapter(recording_id=rec_id, idx=0, start=0.0, end=120.0, title="Begrüßung"))
        s.add(Chapter(recording_id=rec_id, idx=1, start=120.0, end=400.0, title="Hauptteil"))
        s.commit()

    r = client.get(f"/api/recordings/{rec_id}/chapters")
    assert [c["title"] for c in r.json()] == ["Begrüßung", "Hauptteil"]

    r = client.get(f"/api/recordings/{rec_id}/chapters/export?format=youtube")
    assert r.status_code == 200
    assert r.text.splitlines() == ["0:00 Begrüßung", "2:00 Hauptteil"]

    r = client.get(f"/api/recordings/{rec_id}/chapters/export?format=srt")
    assert "00:00:00,000 --> 00:02:00,000" in r.text
    assert "Begrüßung" in r.text

    assert client.delete(f"/api/recordings/{rec_id}/chapters").status_code == 204
    assert client.get(f"/api/recordings/{rec_id}/chapters").json() == []
    assert client.get(f"/api/recordings/{rec_id}/chapters/export").status_code == 404


# ── Speaker stats ────────────────────────────────────────────────────────────

def test_speaker_stats_shares_interruptions_timeline(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import DiarizationRun, Segment, SpeakerLabel

    rec_id, _ = _make_recording(duration=100.0)
    with Session(db.get_engine()) as s:
        run = DiarizationRun(recording_id=rec_id, model="test")
        s.add(run)
        s.flush()
        # A talks 0-60, B 55-80 (interrupts A), A 80-100.
        s.add(Segment(run_id=run.id, start=0.0, end=60.0, speaker_label="SPEAKER_00"))
        s.add(Segment(run_id=run.id, start=55.0, end=80.0, speaker_label="SPEAKER_01"))
        s.add(Segment(run_id=run.id, start=80.0, end=100.0, speaker_label="SPEAKER_00"))
        s.add(SpeakerLabel(recording_id=rec_id, original_label="SPEAKER_00", display_name="Anna"))
        s.commit()

    r = client.get(f"/api/recordings/{rec_id}/speaker-stats")
    assert r.status_code == 200
    data = r.json()
    by_name = {sp["name"]: sp for sp in data["speakers"]}
    assert by_name["Anna"]["talk_sec"] == 80.0
    assert by_name["SPEAKER_01"]["talk_sec"] == 25.0
    assert by_name["Anna"]["share"] > by_name["SPEAKER_01"]["share"]
    assert by_name["SPEAKER_01"]["interruptions_made"] == 1
    assert by_name["Anna"]["interruptions_received"] == 1
    assert data["num_buckets"] > 0
    assert len(by_name["Anna"]["timeline"]) == data["num_buckets"]
    # Timeline mass equals talk time (within float tolerance).
    assert abs(sum(by_name["Anna"]["timeline"]) - 80.0) < 1.0


def test_speaker_stats_404_without_diarization(client):
    rec_id, _ = _make_recording()
    assert client.get(f"/api/recordings/{rec_id}/speaker-stats").status_code == 404


def test_delete_recording_removes_insights(client):
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem, Chapter

    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as s:
        s.add(ActionItem(recording_id=rec_id, text="X"))
        s.add(Chapter(recording_id=rec_id, idx=0, start=0.0, title="K"))
        s.commit()

    assert client.delete(f"/api/recordings/{rec_id}").status_code == 204
    with Session(db.get_engine()) as s:
        assert not s.exec(select(ActionItem)).all()
        assert not s.exec(select(Chapter)).all()

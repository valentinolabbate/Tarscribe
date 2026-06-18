"""Tests for action items, chapters, speaker stats, and the analysis parsers."""

from __future__ import annotations

import importlib
import tempfile
from datetime import datetime, timedelta, timezone

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


def _make_recording(duration: float = 100.0, created_at=None):
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
            created_at=created_at or datetime.now(timezone.utc),
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


def test_action_items_mine_flagging_and_import(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem, KnownSpeaker

    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as s:
        me = KnownSpeaker(name="Valentino L'Abbate")
        s.add(me)
        s.flush()
        me_id = me.id
        s.add(ActionItem(recording_id=rec_id, kind="task", text="A", assignee="Valentino"))
        s.add(ActionItem(recording_id=rec_id, kind="task", text="B", assignee="Anna"))
        s.add(ActionItem(recording_id=rec_id, kind="decision", text="C", assignee=None))
        s.commit()

    # No "me" configured yet → nothing is mine.
    items = client.get("/api/action-items").json()
    assert {i["text"]: i["is_mine"] for i in items} == {"A": False, "B": False, "C": False}

    # Designate the known speaker as "me": first-name match flags item A.
    assert client.put("/api/settings", json={"my_speaker_id": me_id}).status_code == 200
    items = client.get("/api/action-items").json()
    mine = {i["text"]: i["is_mine"] for i in items}
    assert mine == {"A": True, "B": False, "C": False}

    # Importing another item sets include_in_tasks (round-trips in the payload).
    item_b = next(i for i in items if i["text"] == "B")
    r = client.patch(f"/api/action-items/{item_b['id']}", json={"include_in_tasks": True})
    assert r.status_code == 200
    assert r.json()["include_in_tasks"] is True
    assert r.json()["is_mine"] is False

    # Clearing "me" again (sentinel 0) drops the assignment.
    assert client.put("/api/settings", json={"my_speaker_id": 0}).status_code == 200
    items = client.get("/api/action-items").json()
    assert all(i["is_mine"] is False for i in items)


def test_extract_endpoint_enqueues_job(client, monkeypatch):
    import tarscribe_backend.jobs as jobs

    rec_id, _ = _make_recording()
    monkeypatch.setattr(jobs._executor, "submit", lambda *a, **k: None)
    r = client.post(f"/api/recordings/{rec_id}/action-items/extract")
    assert r.status_code == 200
    assert r.json()["job_id"] > 0


def test_action_item_due_date_patch_clear_and_ics_export(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem

    rec_id, topic_id = _make_recording()
    with Session(db.get_engine()) as s:
        s.add(ActionItem(recording_id=rec_id, kind="task", text="Bericht abgeben", assignee="Anna"))
        s.add(ActionItem(recording_id=rec_id, kind="task", text="Ohne Frist"))
        s.commit()

    items = client.get(f"/api/recordings/{rec_id}/action-items").json()
    with_due = next(i for i in items if i["text"] == "Bericht abgeben")
    assert with_due["due_date"] is None

    # Set a structured due date.
    r = client.patch(f"/api/action-items/{with_due['id']}", json={"due_date": "2026-06-20"})
    assert r.status_code == 200
    assert r.json()["due_date"] == "2026-06-20"

    # Only the dated, open task shows up in the calendar export.
    ics = client.get("/api/action-items/export.ics")
    assert ics.status_code == 200
    assert ics.headers["content-type"].startswith("text/calendar")
    body = ics.text
    assert "BEGIN:VCALENDAR" in body and "END:VCALENDAR" in body
    assert "SUMMARY:Bericht abgeben" in body
    assert "DTSTART;VALUE=DATE:20260620" in body
    assert "DTEND;VALUE=DATE:20260621" in body
    assert "Verantwortlich: Anna" in body
    assert "Ohne Frist" not in body

    # Topic filter that matches keeps it; a different topic empties the export.
    assert client.get(f"/api/action-items/export.ics?topic_id={topic_id}").status_code == 200
    assert client.get(f"/api/action-items/export.ics?topic_id={topic_id + 999}").status_code == 404

    # Done tasks drop out of the calendar; clearing the date drops it too.
    client.patch(f"/api/action-items/{with_due['id']}", json={"done": True})
    assert client.get("/api/action-items/export.ics").status_code == 404
    r = client.patch(f"/api/action-items/{with_due['id']}", json={"done": False, "due_date": ""})
    assert r.json()["due_date"] is None
    assert client.get("/api/action-items/export.ics").status_code == 404


def test_retry_job_reenqueues_failed_job(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import Job, JobPhase, JobStatus

    monkeypatch.setattr(jobs._executor, "submit", lambda *a, **k: None)
    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as s:
        failed = Job(
            recording_id=rec_id,
            phase=JobPhase.asr,
            status=JobStatus.failed,
            error="boom",
        )
        s.add(failed)
        s.commit()
        failed_id = failed.id

    r = client.post(f"/api/recordings/{rec_id}/jobs/{failed_id}/retry")
    assert r.status_code == 200
    new_id = r.json()["job_id"]
    assert new_id != failed_id
    assert r.json()["phase"] == "asr"

    with Session(db.get_engine()) as s:
        new_job = s.get(Job, new_id)
        assert new_job.phase == JobPhase.asr
        assert new_job.status == JobStatus.pending

    # Retrying a job that is not failed is rejected.
    assert client.post(f"/api/recordings/{rec_id}/jobs/{new_id}/retry").status_code == 409
    # Unknown job id.
    assert client.post(f"/api/recordings/{rec_id}/jobs/999999/retry").status_code == 404


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


# ── Weekly digest ────────────────────────────────────────────────────────────

def test_digest_endpoint_generates_and_lists(client, monkeypatch):
    from pathlib import Path

    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.llm as llm
    from tarscribe_backend.settings_store import save_prefs
    from tarscribe_backend.models import (
        ActionItem,
        DiarizationRun,
        Segment,
        SpeakerLabel,
        Summary,
        Transcript,
        Word,
    )

    now = datetime.now(timezone.utc)
    rec_id, _topic_id = _make_recording(created_at=now - timedelta(days=2))
    old_rec_id, _ = _make_recording(created_at=now - timedelta(days=10))

    with Session(db.get_engine()) as s:
        s.add(Summary(recording_id=rec_id, model="test", content="Budget wurde freigegeben."))
        s.add(ActionItem(recording_id=rec_id, kind="task", text="Folien aktualisieren", assignee="Anna"))
        s.add(ActionItem(recording_id=rec_id, kind="decision", text="Budget freigegeben"))
        run = DiarizationRun(recording_id=rec_id, model="test")
        s.add(run)
        s.flush()
        s.add(Segment(run_id=run.id, start=0.0, end=80.0, speaker_label="SPEAKER_00"))
        s.add(Segment(run_id=run.id, start=80.0, end=100.0, speaker_label="SPEAKER_01"))
        s.add(SpeakerLabel(recording_id=rec_id, original_label="SPEAKER_00", display_name="Anna"))

        old_tr = Transcript(recording_id=old_rec_id, asr_model="test")
        s.add(old_tr)
        s.flush()
        s.add(Word(transcript_id=old_tr.id, idx=0, start=0, end=1, text="Alt "))
        s.commit()

    seen = {}
    monkeypatch.setattr(
        llm,
        "get_llm_config",
        lambda: {
            "model": "digest-model",
            "base_url": "http://llm.test/v1",
            "api_key": None,
            "temperature": 0.3,
            "top_p": None,
            "top_k": None,
            "max_tokens": None,
        },
    )

    def fake_stream(messages, *_args, **_kwargs):
        seen["prompt"] = messages[-1]["content"]
        yield "# Deine Woche\n\n## Kurzüberblick\nBudget geklärt."

    monkeypatch.setattr(llm, "stream_chat", fake_stream)

    r = client.post("/api/digests?days=7")
    assert r.status_code == 200
    data = r.json()
    assert data["model"] == "digest-model"
    assert data["recording_count"] == 1
    assert data["content_markdown"].startswith("# Deine Woche")
    assert "Folien aktualisieren" in seen["prompt"]
    assert "Budget freigegeben" in seen["prompt"]
    assert "Anna 80%" in seen["prompt"]
    assert "Alt" not in seen["prompt"]

    listed = client.get("/api/digests").json()
    assert listed[0]["id"] == data["id"]
    assert client.get(f"/api/digests/{data['id']}").json()["content_markdown"] == data["content_markdown"]

    export_dir = Path(tempfile.mkdtemp(prefix="tarscribe-digest-export-"))
    save_prefs({"digest_export_path": str(export_dir)})
    exported = client.post(f"/api/digests/{data['id']}/send-to-folder")
    assert exported.status_code == 200
    target = Path(exported.json()["path"])
    assert target.parent == export_dir
    assert target.read_text(encoding="utf-8").startswith("# Deine Woche")


def test_digest_endpoint_requires_configured_llm(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import Summary

    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as s:
        s.add(Summary(recording_id=rec_id, model="test", content="Kurzinhalt"))
        s.commit()
    monkeypatch.setattr(
        llm,
        "get_llm_config",
        lambda: {"model": None, "base_url": "http://llm.test/v1"},
    )
    r = client.post("/api/digests?days=7")
    assert r.status_code == 400
    assert "Kein LLM-Modell" in r.json()["detail"]


# ── Cross-recording threads ─────────────────────────────────────────────────

def test_threads_rebuild_groups_recurring_chapters(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Chapter

    rec_a, _ = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=3))
    rec_b, _ = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=1))
    rec_c, _ = _make_recording(created_at=datetime.now(timezone.utc))
    with Session(db.get_engine()) as s:
        s.add(Chapter(recording_id=rec_a, idx=0, start=10, title="Budget Planung"))
        s.add(Chapter(recording_id=rec_b, idx=0, start=20, title="Budget-Planung"))
        s.add(Chapter(recording_id=rec_c, idx=0, start=30, title="Einmaliges Thema"))
        s.commit()

    rebuilt = client.post("/api/threads/rebuild")
    assert rebuilt.status_code == 200
    assert rebuilt.json() == {"threads": 1, "mentions": 2}

    threads = client.get("/api/threads").json()
    assert len(threads) == 1
    assert threads[0]["recording_count"] == 2
    assert {m["recording_id"] for m in threads[0]["mentions"]} == {rec_a, rec_b}

    rec_threads = client.get(f"/api/recordings/{rec_a}/threads").json()
    assert len(rec_threads) == 1
    assert rec_threads[0]["mentions"][0]["start_sec"] == 10


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

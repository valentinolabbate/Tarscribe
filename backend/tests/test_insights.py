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

    def fake_chat(msgs):
        assert "Referenzdatum für relative Fristen: 2026-06-18" in msgs[-1]["content"]
        assert "Das Produkt heißt Tarscribe" in msgs[-1]["content"]
        return (
            '[{"kind": "task", "text": "Bericht schreiben", "assignee": "Anna",'
            '"recipient":"Ben","due": "bis Freitag", "due_date": "2026-06-19",'
            '"source_quote":"Ich schreibe den Bericht bis Freitag",'
            '"source_start_sec":42,"confidence":0.91},'
            '{"kind": "decision", "text": "Budget freigegeben", "assignee": null,'
            '"due": null, "due_date": null},'
            '{"kind": "task", "text": "Bericht schreiben!", "assignee": null, "due": null},'
            '{"kind": "quatsch", "text": "X klären", "assignee": null,'
            '"due": "am 30. Februar", "due_date": "2026-02-30"},'
            '{"kind": "task", "text": "", "assignee": null, "due": null}]'
        )

    items = extract_action_items(
        fake_chat,
        "Transkript",
        ["Anna"],
        reference_date="2026-06-18",
        clarification="Das Produkt heißt Tarscribe.",
    )
    texts = [i["text"] for i in items]
    assert "Bericht schreiben" in texts
    assert "Budget freigegeben" in texts
    assert len([t for t in texts if t.lower().startswith("bericht")]) == 1  # dedupe
    assert all(i["kind"] in ("task", "decision") for i in items)
    assert next(i for i in items if i["text"] == "Bericht schreiben")["due_date"] == "2026-06-19"
    report = next(i for i in items if i["text"] == "Bericht schreiben")
    assert report["recipient"] == "Ben"
    assert report["source_quote"] == "Ich schreibe den Bericht bis Freitag"
    assert report["source_start_sec"] == 42
    assert report["confidence"] == 0.91
    assert next(i for i in items if i["text"] == "X klären")["due_date"] is None


@pytest.mark.asyncio
async def test_enrich_existing_action_items_accepts_only_known_ids():
    from tarscribe_backend.analysis import enrich_existing_action_items_async

    async def fake_chat(_messages):
        return (
            '[{"item_id":7,"source_quote":"Ich schicke den Bericht.",'
            '"recipient":"Ben","confidence":0.92},'
            '{"item_id":999,"source_quote":"Erfunden","recipient":null,"confidence":1}]'
        )

    result = await enrich_existing_action_items_async(
        fake_chat,
        "[00:00:12] Anna: Ich schicke den Bericht.",
        [{"id": 7, "kind": "task", "text": "Bericht schicken"}],
    )

    assert result == [
        {
            "item_id": 7,
            "source_quote": "Ich schicke den Bericht.",
            "recipient": "Ben",
            "confidence": 0.92,
        }
    ]


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

    r = client.patch(
        f"/api/action-items/{item_id}",
        json={
            "text": "Folien für Tarscribe aktualisieren",
            "assignee": "Anna",
            "due": "bis Freitag",
            "due_date": "2026-06-19",
            "recipient": "Ben",
            "review_state": "confirmed",
        },
    )
    assert r.status_code == 200
    assert r.json()["text"] == "Folien für Tarscribe aktualisieren"
    assert r.json()["assignee"] == "Anna"
    assert r.json()["due_date"] == "2026-06-19"
    assert r.json()["recipient"] == "Ben"
    assert r.json()["review_state"] == "confirmed"

    r = client.patch(f"/api/action-items/{item_id}", json={"done": True})
    assert r.status_code == 200
    assert r.json()["done"] is True
    assert len(client.get("/api/action-items?done=false").json()) == 0

    assert client.delete(f"/api/action-items/{item_id}").status_code == 204
    assert len(client.get("/api/action-items").json()) == 1


def test_project_memory_radar_and_decision_ledger(client):
    from datetime import date, timedelta

    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem

    rec_id, _ = _make_recording()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    with Session(db.get_engine()) as s:
        decision = ActionItem(
            recording_id=rec_id,
            kind="decision",
            text="SQLite bleibt gesetzt",
            review_state="confirmed",
            decision_status="current",
            source_quote="Wir bleiben bei SQLite.",
            source_start_sec=84,
            confidence=0.95,
        )
        s.add(decision)
        s.add(
            ActionItem(
                recording_id=rec_id,
                kind="task",
                text="Migration prüfen",
                assignee="Ada",
                due_date=yesterday,
                review_state="pending",
                source_quote="Ich prüfe die Migration morgen.",
                source_start_sec=120,
                confidence=0.88,
            )
        )
        s.commit()

    response = client.get("/api/memory")
    assert response.status_code == 200
    memory = response.json()
    assert memory["stats"]["open_commitments"] == 1
    assert memory["stats"]["overdue_commitments"] == 1
    assert memory["stats"]["needs_review"] == 1
    assert memory["stats"]["current_decisions"] == 1
    commitment = memory["commitments"][0]
    assert {"overdue", "needs_review"} <= set(commitment["attention_flags"])
    assert commitment["source_start_sec"] == 120
    assert memory["decisions"][0]["source_quote"] == "Wir bleiben bei SQLite."


@pytest.mark.asyncio
async def test_memory_enrichment_preserves_existing_item_state(client, monkeypatch):
    from sqlmodel import Session, select

    import tarscribe_backend.agent as agent
    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import (
        ActionItem,
        MemoryEnrichmentRun,
        Transcript,
        Word,
    )

    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as session:
        transcript = Transcript(recording_id=rec_id, asr_model="test")
        session.add(transcript)
        session.flush()
        session.add(
            Word(
                transcript_id=transcript.id,
                idx=0,
                start=12,
                end=15,
                text="Ich schicke den Bericht bis Freitag.",
            )
        )
        item = ActionItem(
            recording_id=rec_id,
            kind="task",
            text="Bericht verschicken",
            assignee="Anna",
            due="bis Freitag",
            due_date="2026-07-17",
            done=True,
            review_state="confirmed",
            enrichment_state="pending",
        )
        run = MemoryEnrichmentRun(status="pending", total_recordings=1, total_items=1)
        session.add(item)
        session.add(run)
        session.commit()
        item_id = item.id
        run_id = run.id

    async def fake_chat(_messages):
        return (
            f'[{{"item_id":{item_id},'
            '"source_quote":"Ich schicke den Bericht bis Freitag.",'
            '"recipient":"Ben","confidence":0.94}]'
        )

    monkeypatch.setattr(agent, "get_agent_rag_config", lambda *_args: {"enabled": False})
    monkeypatch.setattr(agent, "research_active", lambda _cfg: False)
    monkeypatch.setattr(jobs, "_llm_chat_fn_async", lambda *_args: fake_chat)

    await jobs._run_memory_enrichment_async(run_id)

    with Session(db.get_engine()) as session:
        stored = session.get(ActionItem, item_id)
        assert stored.text == "Bericht verschicken"
        assert stored.assignee == "Anna"
        assert stored.due == "bis Freitag"
        assert stored.due_date == "2026-07-17"
        assert stored.done is True
        assert stored.review_state == "confirmed"
        assert stored.source_quote == "Ich schicke den Bericht bis Freitag."
        assert stored.source_start_sec == 12
        assert stored.recipient == "Ben"
        assert stored.confidence == 0.94
        assert stored.enrichment_state == "enriched"
        finished = session.get(MemoryEnrichmentRun, run_id)
        assert finished.status == "done"
        assert finished.enriched_items == 1
        assert not session.exec(
            select(ActionItem).where(ActionItem.enrichment_state == "pending")
        ).all()

    status = client.get("/api/memory/enrichment")
    assert status.status_code == 200
    assert status.json()["eligible_items"] == 0
    assert status.json()["retryable_items"] == 0
    assert status.json()["restartable_items"] == 0
    assert "done" in status.json()["preserved_fields"]


def test_memory_enrichment_start_without_candidates_finishes_immediately(client):
    response = client.post("/api/memory/enrichment")
    assert response.status_code == 200
    run = response.json()["run"]
    assert run["status"] == "done"
    assert run["total_items"] == 0
    assert run["progress"] == 1.0


def test_memory_enrichment_retry_resets_only_unmatched_metadata(client, monkeypatch):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import ActionItem, MemoryEnrichmentRun

    rec_id, _ = _make_recording()
    with Session(db.get_engine()) as session:
        item = ActionItem(
            recording_id=rec_id,
            kind="task",
            text="Bericht verschicken",
            assignee="Anna",
            due_date="2026-07-17",
            done=True,
            enrichment_state="no_match",
        )
        run = MemoryEnrichmentRun(status="done", total_recordings=1, total_items=1)
        session.add(item)
        session.add(run)
        session.commit()
        item_id = item.id
        run_id = run.id

    status = client.get("/api/memory/enrichment").json()
    assert status["eligible_items"] == 0
    assert status["retryable_items"] == 1
    assert status["restartable_items"] == 1
    assert status["restartable_recordings"] == 1

    with Session(db.get_engine()) as session:
        reset = jobs._reset_memory_enrichment_retry_candidates(session)
        session.commit()
        assert [candidate.id for candidate in reset] == [item_id]
        stored = session.get(ActionItem, item_id)
        assert stored.enrichment_state == "pending"
        assert stored.text == "Bericht verschicken"
        assert stored.assignee == "Anna"
        assert stored.due_date == "2026-07-17"
        assert stored.done is True

    called = {}

    def fake_enqueue(*, retry_no_match=False):
        called["retry_no_match"] = retry_no_match
        return run_id

    monkeypatch.setattr(jobs, "enqueue_memory_enrichment", fake_enqueue)
    response = client.post("/api/memory/enrichment/retry")
    assert response.status_code == 200
    assert called == {"retry_no_match": True}


def test_memory_enrichment_source_time_uses_quote_starting_line():
    from tarscribe_backend.jobs import _source_quote_position

    transcript = (
        "[00:00:12] Transkript: Zuerst besprechen wir das Budget.\n"
        "[00:00:36] Transkript: Ich schicke den Bericht bis Freitag."
    )
    assert _source_quote_position(transcript, "Ich schicke den Bericht bis Freitag.") == 36


def test_memory_item_marks_direct_and_recording_involvement():
    from tarscribe_backend.models import ActionItem
    from tarscribe_backend.routers.insights import _item_dict

    recipient_item = ActionItem(
        recording_id=7,
        kind="task",
        text="Bericht senden",
        assignee="Anna",
        recipient="Valentino",
    )
    recipient_payload = _item_dict(recipient_item, my_name="Valentino L'Abbate")
    assert recipient_payload["is_mine"] is False
    assert recipient_payload["is_involved"] is True

    decision = ActionItem(recording_id=8, kind="decision", text="Beta startet")
    decision_payload = _item_dict(
        decision,
        my_name="Valentino L'Abbate",
        involved_recording_ids={8},
    )
    assert decision_payload["is_involved"] is True


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
    monkeypatch.setattr(jobs, "_submit_llm_job", lambda *a, **k: None)
    r = client.post(f"/api/recordings/{rec_id}/action-items/extract")
    assert r.status_code == 200
    assert r.json()["job_id"] > 0


def test_extract_endpoint_forwards_optional_clarification(client, monkeypatch):
    import tarscribe_backend.jobs as jobs

    rec_id, _ = _make_recording()
    submitted: list[tuple] = []
    monkeypatch.setattr(jobs, "_submit_llm_job", lambda *args: submitted.append(args))

    r = client.post(
        f"/api/recordings/{rec_id}/action-items/extract",
        json={"clarification": "  Das Produkt heißt Tarscribe.  "},
    )

    assert r.status_code == 200
    assert submitted[0][-1] == "Das Produkt heißt Tarscribe."


def test_run_action_items_persists_llm_due_date(client, monkeypatch):
    from sqlmodel import Session, select

    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import ActionItem, Job, JobPhase, JobStatus, Transcript, Word

    rec_id, _ = _make_recording(created_at=datetime(2026, 6, 18, tzinfo=timezone.utc))
    with Session(db.get_engine()) as s:
        transcript = Transcript(recording_id=rec_id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Bitte "))
        s.add(Word(transcript_id=transcript.id, idx=1, start=1, end=2, text="Bericht "))
        s.add(Word(transcript_id=transcript.id, idx=2, start=2, end=3, text="morgen "))
        job = Job(recording_id=rec_id, phase=JobPhase.action_items, status=JobStatus.pending)
        s.add(job)
        s.commit()
        job_id = job.id

    async def fake_chat(msgs):
        assert "Referenzdatum für relative Fristen: 2026-06-18" in msgs[-1]["content"]
        return (
            '[{"kind":"task","text":"Bericht schreiben","assignee":null,'
            '"due":"morgen","due_date":"2026-06-19"}]'
        )

    monkeypatch.setattr(jobs, "_llm_chat_fn_async", lambda *_args: fake_chat)
    jobs._run_action_items(rec_id, job_id)

    with Session(db.get_engine()) as s:
        items = s.exec(select(ActionItem).where(ActionItem.recording_id == rec_id)).all()
        assert len(items) == 1
        assert items[0].due == "morgen"
        assert items[0].due_date == "2026-06-19"
        assert s.get(Job, job_id).status == JobStatus.done


def test_run_action_items_auto_syncs_caldav(client, monkeypatch):
    from sqlmodel import Session, select

    import httpx
    import tarscribe_backend.calendar_sync as calendar_sync
    import tarscribe_backend.db as db
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import ActionItem, Job, JobPhase, JobStatus, Topic, Transcript, Word

    requests: list[tuple[str, str, bytes]] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def put(self, url, content=None, headers=None):
            requests.append(("PUT", url, content or b""))
            return httpx.Response(201, headers={"ETag": '"abc"'})

        def delete(self, url):
            requests.append(("DELETE", url, b""))
            return httpx.Response(204)

    monkeypatch.setattr(calendar_sync.httpx, "Client", FakeClient)
    client.put("/api/settings", json={"caldav": {"url": "https://dav.example/cal/", "username": "u"}})

    rec_id, topic_id = _make_recording(created_at=datetime(2026, 6, 18, tzinfo=timezone.utc))
    with Session(db.get_engine()) as s:
        topic = s.get(Topic, topic_id)
        topic.calendar_export_mode = "auto"
        s.add(topic)
        transcript = Transcript(recording_id=rec_id, asr_model="test")
        s.add(transcript)
        s.flush()
        s.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Bericht morgen"))
        job = Job(recording_id=rec_id, phase=JobPhase.action_items, status=JobStatus.pending)
        s.add(job)
        s.commit()
        job_id = job.id

    async def fake_chat(_msgs):
        return (
            '[{"kind":"task","text":"Bericht schreiben","assignee":"Anna",'
            '"due":"morgen","due_date":"2026-06-19"}]'
        )

    monkeypatch.setattr(jobs, "_llm_chat_fn_async", lambda *_args: fake_chat)
    jobs._run_action_items(rec_id, job_id)

    with Session(db.get_engine()) as s:
        item = s.exec(select(ActionItem).where(ActionItem.recording_id == rec_id)).one()
        assert item.calendar_status == "synced"
        assert item.calendar_href.startswith("https://dav.example/cal/tarscribe-task-")
        assert item.calendar_etag == '"abc"'
    assert requests and requests[0][0] == "PUT"
    assert b"SUMMARY:Bericht schreiben" in requests[0][2]


def test_action_item_calendar_approval_flow(client, monkeypatch):
    from sqlmodel import Session

    import httpx
    import tarscribe_backend.calendar_sync as calendar_sync
    import tarscribe_backend.db as db
    from tarscribe_backend.models import ActionItem, Topic

    requests: list[str] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def put(self, url, content=None, headers=None):
            requests.append(url)
            return httpx.Response(201)

        def delete(self, url):
            return httpx.Response(204)

    monkeypatch.setattr(calendar_sync.httpx, "Client", FakeClient)
    client.put("/api/settings", json={"caldav": {"url": "https://dav.example/cal/", "username": ""}})

    rec_id, topic_id = _make_recording()
    with Session(db.get_engine()) as s:
        topic = s.get(Topic, topic_id)
        topic.calendar_export_mode = "approval"
        s.add(topic)
        s.add(
            ActionItem(
                recording_id=rec_id,
                kind="task",
                text="Folien senden",
                due="Freitag",
                due_date="2026-06-19",
            )
        )
        s.commit()

    item = client.get(f"/api/recordings/{rec_id}/action-items").json()[0]
    patched = client.patch(f"/api/action-items/{item['id']}", json={"due_date": "2026-06-19"}).json()
    assert patched["calendar_status"] == "pending_approval"
    assert requests == []

    synced = client.post(f"/api/action-items/{item['id']}/calendar-sync").json()
    assert synced["calendar_status"] == "synced"
    assert len(requests) == 1


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
        lambda *_args: {
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
        lambda *_args: {"model": None, "base_url": "http://llm.test/v1"},
    )
    r = client.post("/api/digests?days=7")
    assert r.status_code == 400
    assert "Kein Chat-Modell" in r.json()["detail"]


# ── Cross-recording threads ─────────────────────────────────────────────────

def test_threads_rebuild_clusters_semantically_similar_transcripts(client):
    import numpy as np
    import sqlite_vec
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import Chapter, RagChunk

    if not db.vec_available():
        pytest.skip("sqlite-vec extension not available")

    rec_a, topic_a = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=3))
    rec_b, topic_b = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=1))
    rec_c, topic_c = _make_recording(created_at=datetime.now(timezone.utc))
    with Session(db.get_engine()) as s:
        chapters = [
            Chapter(recording_id=rec_a, idx=0, start=10, title="Budget Planung"),
            Chapter(recording_id=rec_b, idx=0, start=20, title="Finanzrahmen für Q3"),
            Chapter(recording_id=rec_c, idx=0, start=30, title="Budget Planung"),
        ]
        s.add_all(chapters)
        chunks = [
            RagChunk(
                recording_id=rec_a,
                topic_id=topic_a,
                source_type="transcript",
                chunk_index=0,
                text="Das Team plant die Finanzierung und verteilt das Quartalsbudget auf Projekte.",
                start_sec=12,
                content_hash="a",
                embed_model="test",
            ),
            RagChunk(
                recording_id=rec_b,
                topic_id=topic_b,
                source_type="transcript",
                chunk_index=0,
                text="Für das dritte Quartal wird der verfügbare Finanzrahmen neu aufgeteilt.",
                start_sec=22,
                content_hash="b",
                embed_model="test",
            ),
            RagChunk(
                recording_id=rec_c,
                topic_id=topic_c,
                source_type="transcript",
                chunk_index=0,
                text="Trotz gleicher Kapitelwörter handelt dieses Gespräch von einem anderen Thema.",
                start_sec=32,
                content_hash="c",
                embed_model="test",
            ),
        ]
        s.add_all(chunks)
        s.flush()
        vectors = []
        for values in ((1.0, 0.0), (0.96, 0.28), (0.0, 1.0)):
            vector = np.zeros(768, dtype=np.float32)
            vector[:2] = values
            vector /= np.linalg.norm(vector)
            vectors.append(vector)
        conn = s.connection()
        for chunk, vector in zip(chunks, vectors, strict=True):
            conn.exec_driver_sql(
                "INSERT INTO rag_chunk_vec(rowid, embedding, topic_id, recording_id) "
                "VALUES (?, ?, ?, ?)",
                (
                    chunk.id,
                    sqlite_vec.serialize_float32(vector),
                    chunk.topic_id,
                    chunk.recording_id,
                ),
            )
        s.commit()

    rebuilt = client.post("/api/threads/rebuild")
    assert rebuilt.status_code == 200
    assert rebuilt.json() == {
        "threads": 1,
        "mentions": 2,
        "indexed_chunks": 3,
        "mode": "semantic",
        "threshold": 0.72,
    }

    threads = client.get("/api/threads").json()
    assert len(threads) == 1
    assert threads[0]["title"] in {"Budget Planung", "Finanzrahmen für Q3"}
    assert threads[0]["recording_count"] == 2
    assert {m["recording_id"] for m in threads[0]["mentions"]} == {rec_a, rec_b}
    assert all(m["text"] != "Einmaliges Thema" for m in threads[0]["mentions"])

    rec_threads = client.get(f"/api/recordings/{rec_a}/threads").json()
    assert len(rec_threads) == 1
    assert rec_threads[0]["mentions"][0]["start_sec"] == 12


def test_people_memory_collects_sourced_speaker_context(client):
    from sqlmodel import Session

    import tarscribe_backend.db as db
    from tarscribe_backend.models import (
        ActionItem,
        DiarizationRun,
        KnownSpeaker,
        Segment,
        SpeakerLabel,
        ThreadMention,
        TopicThread,
    )

    rec_a, _ = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=3))
    rec_b, _ = _make_recording(created_at=datetime.now(timezone.utc) - timedelta(days=1))
    rec_other, _ = _make_recording(created_at=datetime.now(timezone.utc))
    with Session(db.get_engine()) as s:
        speaker = KnownSpeaker(name="Ada Lovelace", color="#8b5cf6", sample_count=2)
        s.add(speaker)
        s.flush()
        for recording_id, label, start in (
            (rec_a, "SPEAKER_00", 12.0),
            (rec_b, "SPEAKER_01", 25.0),
        ):
            s.add(
                SpeakerLabel(
                    recording_id=recording_id,
                    original_label=label,
                    display_name=speaker.name,
                    known_speaker_id=speaker.id,
                )
            )
            run = DiarizationRun(recording_id=recording_id, model="test", is_active=True)
            s.add(run)
            s.flush()
            s.add(Segment(run_id=run.id, start=start, end=start + 8, speaker_label=label))
        s.add(ActionItem(recording_id=rec_a, kind="task", text="Prototyp bauen", assignee="Ada"))
        s.add(
            ActionItem(
                recording_id=rec_other,
                kind="task",
                text="Review übernehmen",
                assignee="Ada Lovelace",
                done=True,
            )
        )
        s.add(ActionItem(recording_id=rec_b, kind="task", text="Nicht Ada", assignee="Ben"))
        s.add(ActionItem(recording_id=rec_b, kind="decision", text="Launch im Herbst"))
        s.add(ActionItem(recording_id=rec_other, kind="decision", text="Fremde Entscheidung"))
        thread = TopicThread(title="Produktstrategie")
        s.add(thread)
        s.flush()
        s.add(
            ThreadMention(
                thread_id=thread.id,
                recording_id=rec_a,
                start_sec=30,
                text="Produktstrategie",
            )
        )
        s.add(
            ThreadMention(
                thread_id=thread.id,
                recording_id=rec_b,
                start_sec=45,
                text="Produktstrategie",
            )
        )
        s.commit()
        speaker_id = speaker.id

    response = client.get(f"/api/known-speakers/{speaker_id}/memory")
    assert response.status_code == 200
    memory = response.json()
    assert memory["speaker"]["name"] == "Ada Lovelace"
    assert memory["stats"] == {
        "recording_count": 2,
        "open_task_count": 1,
        "decision_count": 1,
        "thread_count": 1,
        "talk_sec": 16.0,
        "last_seen_at": memory["recordings"][0]["created_at"],
    }
    assert {recording["id"] for recording in memory["recordings"]} == {rec_a, rec_b}
    assert {recording["start_sec"] for recording in memory["recordings"]} == {12.0, 25.0}
    assert {item["text"] for item in memory["tasks"]} == {
        "Prototyp bauen",
        "Review übernehmen",
    }
    assert [item["text"] for item in memory["decisions"]] == ["Launch im Herbst"]
    assert memory["threads"][0]["title"] == "Produktstrategie"
    assert {mention["start_sec"] for mention in memory["threads"][0]["mentions"]} == {
        30.0,
        45.0,
    }


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

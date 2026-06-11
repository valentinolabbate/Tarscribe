"""RAG indexing + retrieval tests with mocked embeddings (no network)."""

from __future__ import annotations

import hashlib
import importlib
import tempfile

import pytest


def _fake_vec(text: str, dim: int = 768) -> list[float]:
    """Deterministic unit vector seeded by the text — same text => same vector."""
    import numpy as np

    h = hashlib.sha256(text.encode()).digest()
    rng = np.random.default_rng(int.from_bytes(h[:8], "little"))
    v = rng.standard_normal(dim).astype("float32")
    v /= np.linalg.norm(v)
    return v.tolist()


@pytest.fixture()
def env(monkeypatch):
    """Temp data dir + reloaded db, with embed_texts mocked."""
    tmp = tempfile.mkdtemp(prefix="tarscribe-rag-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)

    import tarscribe_backend.rag as rag

    importlib.reload(rag)

    if not db.vec_available():
        pytest.skip("sqlite-vec extension not available")

    db.init_db()
    monkeypatch.setattr(rag, "embed_texts", lambda texts, **_k: [_fake_vec(t) for t in texts])
    return db, rag


def _make_recording(db, title="Meeting", topic_name="Test", words_text=None):
    from tarscribe_backend.models import Recording, Topic, Transcript, Word

    words_text = words_text or ("Budget Quartal Marketing Strategie Umsatz Planung " * 4)
    with db.session_scope() as s:
        topic = Topic(name=topic_name)
        s.add(topic)
        s.flush()
        rec = Recording(topic_id=topic.id, title=title, audio_path="/x.wav")
        s.add(rec)
        s.flush()
        tr = Transcript(recording_id=rec.id, asr_model="m")
        s.add(tr)
        s.flush()
        for i, w in enumerate(words_text.split(" ")):
            s.add(Word(transcript_id=tr.id, idx=i, start=i * 0.5, end=i * 0.5 + 0.4, text=w + " "))
        return rec.id, topic.id


def test_chunk_transcript_groups_and_carries_timing(env):
    _db, rag = env
    from tarscribe_backend.ml.alignment import Utterance

    utts = [
        Utterance(speaker="Anna", start=0.0, end=2.0, text="Hallo zusammen."),
        Utterance(speaker="Ben", start=2.0, end=4.0, text="Lass uns starten."),
    ]
    chunks = rag.chunk_transcript(utts)
    assert len(chunks) == 1
    assert chunks[0]["start_sec"] == 0.0
    assert chunks[0]["end_sec"] == 4.0
    assert "Anna:" in chunks[0]["text"] and "Ben:" in chunks[0]["text"]


def test_chunk_summary_splits_on_blank_lines(env):
    _db, rag = env
    md = "# Titel\n\nErster Absatz.\n\nZweiter Absatz."
    chunks = rag.chunk_summary(md)
    assert len(chunks) >= 1
    assert all("text" in c for c in chunks)


def test_index_and_search_roundtrip(env):
    db, rag = env
    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        n = rag.index_recording(s, rid)
    assert n >= 1
    from tarscribe_backend.models import RagChunk
    from sqlmodel import select

    with db.session_scope() as s:
        # Querying with the exact chunk text should rank it first (distance ~0).
        chunk_text = s.exec(select(RagChunk)).first().text
        hits = rag.search(s, chunk_text, top_k=5)
    assert hits
    assert hits[0]["recording_id"] == rid
    assert hits[0]["distance"] < 1e-3


def test_reindex_is_idempotent(env):
    db, rag = env
    from tarscribe_backend.models import RagChunk
    from sqlmodel import func, select

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rag.index_recording(s, rid)
    with db.session_scope() as s:
        rag.index_recording(s, rid)  # second pass replaces, no duplicates
        count = s.exec(select(func.count(RagChunk.id))).one()
    assert count >= 1
    # Vec rows match chunk rows.
    with db.session_scope() as s:
        vec_count = s.connection().exec_driver_sql(
            "SELECT count(*) FROM rag_chunk_vec"
        ).fetchone()[0]
        chunk_count = s.exec(select(func.count(RagChunk.id))).one()
    assert vec_count == chunk_count


def test_topic_filter(env):
    db, rag = env
    rid_a, tid_a = _make_recording(db, title="A", topic_name="TopicA")
    rid_b, tid_b = _make_recording(db, title="B", topic_name="TopicB")
    with db.session_scope() as s:
        rag.index_recording(s, rid_a)
        rag.index_recording(s, rid_b)
    with db.session_scope() as s:
        hits = rag.search(s, "Budget", top_k=10, topic_id=tid_a)
    assert hits
    assert all(h["topic_id"] == tid_a for h in hits)


def test_delete_summary_index_removes_summary_chunks(env):
    """Bug 1: deleting an indexed summary must not hit a FK constraint."""
    db, rag = env
    from tarscribe_backend.models import RagChunk, Summary
    from sqlmodel import func, select

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rec_summary = Summary(recording_id=rid, model="m", content="Launch in Q3. Budget 50k.")
        s.add(rec_summary)
        s.flush()
        sid = rec_summary.id
    with db.session_scope() as s:
        rag.index_recording(s, rid)
    with db.session_scope() as s:
        before = s.exec(
            select(func.count(RagChunk.id)).where(RagChunk.summary_id == sid)
        ).one()
    assert before >= 1
    # Mirror the delete_summary flow: clear chunks, then delete the summary.
    with db.session_scope() as s:
        rag.delete_summary_index(s, sid)
        s.delete(s.get(Summary, sid))  # would raise IntegrityError without the cleanup
    with db.session_scope() as s:
        after = s.exec(
            select(func.count(RagChunk.id)).where(RagChunk.summary_id == sid)
        ).one()
        transcript_chunks = s.exec(
            select(func.count(RagChunk.id)).where(RagChunk.recording_id == rid)
        ).one()
    assert after == 0
    assert transcript_chunks >= 1  # transcript chunks survive


def test_model_change_invalidates_index(env):
    """Bug 3/4: switching the embedding model wipes the (now-incomparable) index."""
    db, rag = env
    from tarscribe_backend.models import RagChunk
    from tarscribe_backend.settings_store import save_prefs
    from sqlmodel import func, select

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rag.index_recording(s, rid)
    with db.session_scope() as s:
        assert s.exec(select(func.count(RagChunk.id))).one() >= 1

    # Change the embedding model -> ensure_vec_table reports invalidation + wipes.
    prefs_rag = {"base_url": "http://x/v1", "model": "other-embed", "dimension": 768}
    save_prefs({"rag": prefs_rag})
    invalidated = db._ensure_vec_table()
    assert invalidated is True
    with db.session_scope() as s:
        assert s.exec(select(func.count(RagChunk.id))).one() == 0


def test_cascade_delete_removes_chunks(env):
    db, rag = env
    from tarscribe_backend.models import RagChunk
    from sqlmodel import func, select

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rag.index_recording(s, rid)
    with db.session_scope() as s:
        rag.delete_recording_index(s, rid)
    with db.session_scope() as s:
        count = s.exec(select(func.count(RagChunk.id)).where(RagChunk.recording_id == rid)).one()
        vec_count = s.connection().exec_driver_sql(
            "SELECT count(*) FROM rag_chunk_vec WHERE recording_id = ?", (rid,)
        ).fetchone()[0]
    assert count == 0
    assert vec_count == 0


# ── Hybrid search (FTS5 + vector) ────────────────────────────────────────────

def test_fts_table_stays_in_sync(env):
    db, rag = env
    if not db.fts_available():
        pytest.skip("FTS5 not available")

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rag.index_recording(s, rid)
    with db.session_scope() as s:
        fts = s.connection().exec_driver_sql("SELECT count(*) FROM rag_chunk_fts").fetchone()[0]
        chunks = s.connection().exec_driver_sql("SELECT count(*) FROM rag_chunks").fetchone()[0]
    assert fts == chunks >= 1

    with db.session_scope() as s:
        rag.delete_recording_index(s, rid)
    with db.session_scope() as s:
        fts = s.connection().exec_driver_sql("SELECT count(*) FROM rag_chunk_fts").fetchone()[0]
    assert fts == 0


def test_hybrid_search_falls_back_to_keywords_when_embeddings_down(env, monkeypatch):
    db, rag = env
    if not db.fts_available():
        pytest.skip("FTS5 not available")

    rid, _tid = _make_recording(db, words_text="Der Liefertermin für das Velociraptor Projekt ist Montag " * 3)
    with db.session_scope() as s:
        rag.index_recording(s, rid)

    def boom(_text):
        raise RuntimeError("embedding server down")

    monkeypatch.setattr(rag, "embed_query", boom)
    with db.session_scope() as s:
        hits = rag.search(s, "Velociraptor", top_k=5)
    assert hits
    assert hits[0]["recording_id"] == rid
    assert hits[0]["distance"] is None  # keyword-only hit
    assert hits[0]["score"] > 0


def test_hybrid_search_keyword_boosts_exact_term(env):
    db, rag = env
    if not db.fts_available():
        pytest.skip("FTS5 not available")

    rid_a, _ = _make_recording(db, title="Mit Begriff", words_text="Zephyrium Konfiguration Setup Server " * 5)
    rid_b, _ = _make_recording(db, title="Ohne Begriff", words_text="Frühstück Kaffee Wetter Wochenende " * 5)
    with db.session_scope() as s:
        rag.index_recording(s, rid_a)
        rag.index_recording(s, rid_b)
    with db.session_scope() as s:
        hits = rag.search(s, "Zephyrium", top_k=2)
    assert hits
    assert hits[0]["recording_id"] == rid_a


def test_search_date_and_speaker_filters(env):
    db, rag = env
    from datetime import datetime, timezone

    from sqlmodel import select

    from tarscribe_backend.models import RagChunk, Recording

    rid, _tid = _make_recording(db)
    with db.session_scope() as s:
        rag.index_recording(s, rid)
        # Annotate chunks with a speaker and pin the recording date.
        for chunk in s.exec(select(RagChunk)).all():
            chunk.speaker = "Anna"
            s.add(chunk)
        rec = s.get(Recording, rid)
        rec.created_at = datetime(2026, 6, 1, tzinfo=timezone.utc)
        s.add(rec)

    with db.session_scope() as s:
        assert rag.search(s, "Budget", top_k=5, speaker="anna")
        assert not rag.search(s, "Budget", top_k=5, speaker="Bernd")
        assert rag.search(s, "Budget", top_k=5, date_from="2026-05-01", date_to="2026-06-30")
        assert not rag.search(s, "Budget", top_k=5, date_to="2026-05-31")
        assert not rag.search(s, "Budget", top_k=5, date_from="2026-06-02")

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

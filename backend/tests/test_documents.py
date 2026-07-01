"""Document upload/extraction/indexing tests with mocked embeddings (no network)."""

from __future__ import annotations

import hashlib
import importlib
import tempfile
from pathlib import Path

import pytest


def _fake_vec(text: str, dim: int = 768) -> list[float]:
    import numpy as np

    h = hashlib.sha256(text.encode()).digest()
    rng = np.random.default_rng(int.from_bytes(h[:8], "little"))
    v = rng.standard_normal(dim).astype("float32")
    v /= np.linalg.norm(v)
    return v.tolist()


@pytest.fixture()
def env(monkeypatch):
    """Temp data dir + reloaded db/rag, with embed_texts mocked."""
    tmp = tempfile.mkdtemp(prefix="tarscribe-doc-test-")
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


def _make_topic(db, name="Docs") -> int:
    from tarscribe_backend.models import Topic

    with db.session_scope() as s:
        topic = Topic(name=name)
        s.add(topic)
        s.flush()
        return topic.id


def _make_recording(db, topic_id, title="Rec") -> int:
    from tarscribe_backend.models import Recording

    with db.session_scope() as s:
        rec = Recording(topic_id=topic_id, title=title, audio_path="/x.wav")
        s.add(rec)
        s.flush()
        return rec.id


def _make_document(db, topic_id, *, recording_id=None, text="", title="Doc") -> int:
    """Persist a .txt document file + Document row, return its id."""
    from tarscribe_backend.config import get_settings
    from tarscribe_backend.models import Document

    path = get_settings().documents_dir / f"{title}.txt"
    path.write_text(text, encoding="utf-8")
    with db.session_scope() as s:
        doc = Document(
            topic_id=topic_id,
            recording_id=recording_id,
            title=title,
            original_filename=path.name,
            file_path=str(path),
            content_type="text/plain",
        )
        s.add(doc)
        s.flush()
        return doc.id


# ── extraction ───────────────────────────────────────────────────────────────

def test_extract_text_txt(env):
    from tarscribe_backend.documents import extract_text

    p = Path(tempfile.mkstemp(suffix=".md")[1])
    p.write_text("# Titel\n\nInhalt.", encoding="utf-8")
    assert "Inhalt" in extract_text(p)


def test_extract_text_docx(env):
    docx = pytest.importorskip("docx")
    from tarscribe_backend.documents import extract_text

    document = docx.Document()
    document.add_paragraph("Quartalsbericht Velociraptor Projekt")
    p = Path(tempfile.mkstemp(suffix=".docx")[1])
    document.save(str(p))
    assert "Velociraptor" in extract_text(p)


def test_extract_text_rejects_empty(env):
    from tarscribe_backend.documents import DocumentError, extract_text

    p = Path(tempfile.mkstemp(suffix=".txt")[1])
    p.write_text("   \n  ", encoding="utf-8")
    with pytest.raises(DocumentError):
        extract_text(p)


# ── indexing + search ────────────────────────────────────────────────────────

def test_index_document_appears_in_search(env):
    db, rag = env
    from sqlmodel import select

    from tarscribe_backend.models import RagChunk

    tid = _make_topic(db)
    text = "Zephyrium Konfiguration und Setup des Servers für das Projekt. " * 6
    did = _make_document(db, tid, text=text, title="Setup-Guide")
    with db.session_scope() as s:
        n = rag.index_document(s, did)
    assert n >= 1

    with db.session_scope() as s:
        chunk = s.exec(select(RagChunk).where(RagChunk.document_id == did)).first()
        assert chunk.source_type == "document"
        assert chunk.recording_id is None
        hits = rag.search(s, "Zephyrium Konfiguration", top_k=5)
    assert hits
    assert hits[0]["document_id"] == did
    assert hits[0]["source_type"] == "document"
    assert hits[0]["recording_title"] == "Setup-Guide"


def test_topic_document_excluded_from_recording_scope(env):
    db, rag = env
    tid = _make_topic(db)
    rid = _make_recording(db, tid)
    did = _make_document(db, tid, text="Antarktisexpedition Logistikplan Details. " * 6)
    with db.session_scope() as s:
        rag.index_document(s, did)
    with db.session_scope() as s:
        # Global / topic scope sees the document...
        assert rag.search(s, "Antarktisexpedition Logistikplan", top_k=5)
        assert rag.search(s, "Antarktisexpedition Logistikplan", top_k=5, topic_id=tid)
        # ...but a recording-scoped query must not return a topic-level document.
        assert not rag.search(
            s, "Antarktisexpedition Logistikplan", top_k=5, recording_id=rid
        )


def test_recording_document_included_in_recording_scope(env):
    db, rag = env
    tid = _make_topic(db)
    rid = _make_recording(db, tid)
    did = _make_document(
        db, tid, recording_id=rid, text="Sitzungsprotokoll Brontosaurus Beschluss. " * 6
    )
    with db.session_scope() as s:
        rag.index_document(s, did)
    with db.session_scope() as s:
        hits = rag.search(s, "Brontosaurus Beschluss", top_k=5, recording_id=rid)
    assert hits
    assert hits[0]["document_id"] == did
    assert hits[0]["recording_id"] == rid


def test_summary_knowledge_prefers_recording_document_over_topic_document(env):
    db, rag = env
    tid = _make_topic(db)
    rid = _make_recording(db, tid, title="IGA Strategie")
    rec_doc = _make_document(
        db,
        tid,
        recording_id=rid,
        title="Aufnahme-Agenda",
        text="IGA Strategie Zielbild Leitung Vorbereitung Aufgaben " * 8,
    )
    topic_doc = _make_document(
        db,
        tid,
        title="Themenbereich-Handbuch",
        text="IGA Strategie Zielbild Hintergrund Themenbereich Hinweise " * 8,
    )
    with db.session_scope() as s:
        rag.index_document(s, rec_doc)
        rag.index_document(s, topic_doc)

    with db.session_scope() as s:
        hits = rag.retrieve_topic_knowledge(
            s,
            "IGA Strategie Zielbild",
            tid,
            exclude_recording_id=rid,
            top_k=2,
        )

    assert len(hits) == 2
    assert hits[0]["document_id"] == rec_doc
    assert hits[0]["recording_id"] == rid
    assert hits[1]["document_id"] == topic_doc
    assert hits[1]["recording_id"] is None


def test_delete_document_index_removes_chunks_and_vecs(env):
    db, rag = env
    from sqlmodel import func, select

    from tarscribe_backend.models import RagChunk

    tid = _make_topic(db)
    did = _make_document(db, tid, text="Pterodaktylus Flugbahn Analyse. " * 6)
    with db.session_scope() as s:
        rag.index_document(s, did)
    with db.session_scope() as s:
        rag.delete_document_index(s, did)
    with db.session_scope() as s:
        count = s.exec(
            select(func.count(RagChunk.id)).where(RagChunk.document_id == did)
        ).one()
        fts = s.connection().exec_driver_sql(
            "SELECT count(*) FROM rag_chunk_fts"
        ).fetchone()[0]
    assert count == 0
    assert fts == 0


# ── schema migration (relax recording_id NOT NULL, add document_id) ──────────

def test_migration_rebuilds_legacy_rag_chunks(env):
    db, _rag = env
    import sqlite3

    from tarscribe_backend.config import get_settings

    db_path = str(get_settings().db_path)

    # Recreate rag_chunks in the pre-document shape: recording_id NOT NULL, no
    # document_id column, with one existing row.
    raw = sqlite3.connect(db_path)
    raw.isolation_level = None
    raw.execute("PRAGMA foreign_keys=OFF")
    raw.execute("DROP TABLE rag_chunks")
    raw.execute(
        "CREATE TABLE rag_chunks ("
        " id INTEGER PRIMARY KEY, recording_id INTEGER NOT NULL,"
        " topic_id INTEGER NOT NULL, summary_id INTEGER, source_type VARCHAR NOT NULL,"
        " chunk_index INTEGER NOT NULL, text VARCHAR NOT NULL, start_sec FLOAT,"
        " end_sec FLOAT, speaker VARCHAR, content_hash VARCHAR NOT NULL,"
        " embed_model VARCHAR NOT NULL, created_at DATETIME NOT NULL)"
    )
    raw.execute(
        "INSERT INTO rag_chunks (id, recording_id, topic_id, source_type, chunk_index,"
        " text, content_hash, embed_model, created_at)"
        " VALUES (7, 3, 1, 'transcript', 0, 'alt', 'h', 'm', '2026-01-01')"
    )
    raw.close()

    db._migrate_rag_chunks_for_documents()

    raw = sqlite3.connect(db_path)
    cols = {r[1]: r for r in raw.execute("PRAGMA table_info(rag_chunks)")}
    assert "document_id" in cols
    # recording_id NOT NULL relaxed (notnull flag is column[3]).
    assert cols["recording_id"][3] == 0
    # Existing row preserved with its id.
    assert raw.execute("SELECT recording_id, text FROM rag_chunks WHERE id=7").fetchone() == (3, "alt")
    # A topic-level document chunk (NULL recording_id) now inserts cleanly.
    raw.execute(
        "INSERT INTO rag_chunks (recording_id, topic_id, document_id, source_type,"
        " chunk_index, text, content_hash, embed_model, created_at)"
        " VALUES (NULL, 1, 5, 'document', 0, 'x', 'h', 'm', '2026-01-02')"
    )
    raw.close()


# ── HTTP router (RAG disabled → no embedding call) ───────────────────────────

@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-doc-api-")
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


def test_upload_list_download_delete(client):
    topic = client.post("/api/topics", json={"name": "Wissen"}).json()
    r = client.post(
        "/api/documents",
        data={"topic_id": topic["id"], "title": "Handbuch"},
        files={"file": ("handbuch.txt", b"Wichtige Referenz zum Projekt.", "text/plain")},
    )
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["title"] == "Handbuch"
    assert doc["recording_id"] is None
    assert doc["status"] == "uploaded"  # RAG disabled → not indexed

    listed = client.get(f"/api/documents?topic_id={topic['id']}").json()
    assert [d["id"] for d in listed] == [doc["id"]]

    dl = client.get(f"/api/documents/{doc['id']}/file")
    assert dl.status_code == 200
    assert dl.content == b"Wichtige Referenz zum Projekt."

    assert client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert client.get(f"/api/documents?topic_id={topic['id']}").json() == []


def test_upload_rejects_unsupported_format(client):
    topic = client.post("/api/topics", json={"name": "Wissen"}).json()
    r = client.post(
        "/api/documents",
        data={"topic_id": topic["id"]},
        files={"file": ("bild.png", b"\x89PNG", "image/png")},
    )
    assert r.status_code == 400


def test_recording_scoped_listing(client):
    from tarscribe_backend.models import Recording

    topic = client.post("/api/topics", json={"name": "Wissen"}).json()
    import tarscribe_backend.db as db

    with db.session_scope() as s:
        rec = Recording(topic_id=topic["id"], title="Sitzung", audio_path="/x.wav")
        s.add(rec)
        s.flush()
        rec_id = rec.id

    client.post(
        "/api/documents",
        data={"topic_id": topic["id"], "recording_id": rec_id},
        files={"file": ("anhang.md", b"# Anhang\nDetails.", "text/markdown")},
    )
    # Listed under the recording, but not among the topic-level documents.
    assert len(client.get(f"/api/documents?recording_id={rec_id}").json()) == 1
    assert client.get(f"/api/documents?topic_id={topic['id']}").json() == []

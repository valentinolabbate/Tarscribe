"""RAG indexing + retrieval over transcripts and summaries.

Embeddings are produced by a separately configured OpenAI-compatible endpoint
(default Ollama) — independent from the chat ``llm`` config. Vectors are stored in
the ``rag_chunk_vec`` sqlite-vec virtual table; text + metadata live in ``RagChunk``.
"""

from __future__ import annotations

import hashlib

import httpx
from sqlmodel import Session, select

from .llm import _auth_headers
from .models import (
    DiarizationRun,
    Document,
    RagChunk,
    Recording,
    Segment,
    SpeakerLabel,
    Summary,
    Transcript,
    Word,
)
from .settings_store import get_rag_api_key, load_prefs

# Passage sizing for retrieval (characters). Overlap keeps context across cuts.
CHUNK_CHARS = 1000
CHUNK_OVERLAP = 150
EMBED_BATCH = 32


def get_rag_config() -> dict:
    rag = load_prefs().get("rag") or {}
    return {
        "base_url": (rag.get("base_url") or "http://localhost:11434/v1").rstrip("/"),
        "model": rag.get("model") or "nomic-embed-text",
        "dimension": int(rag.get("dimension") or 768),
        "top_k": int(rag.get("top_k") or 6),
        "api_key": get_rag_api_key(),
    }


def rag_enabled() -> bool:
    """RAG is on only when the user enabled it AND sqlite-vec is available."""
    from .db import vec_available

    return bool(load_prefs().get("rag_enabled")) and vec_available()


# --- embedding client ------------------------------------------------------
def embed_texts(
    texts: list[str], base_url: str | None = None, api_key: str | None = None
) -> list[list[float]]:
    """Embed texts via an OpenAI-compatible /embeddings endpoint (batched)."""
    if not texts:
        return []
    cfg = get_rag_config()
    base = (base_url or cfg["base_url"]).rstrip("/")
    key = api_key if api_key is not None else cfg["api_key"]
    model = cfg["model"]
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i : i + EMBED_BATCH]
        r = httpx.post(
            f"{base}/embeddings",
            json={"model": model, "input": batch},
            headers=_auth_headers(key),
            timeout=120,
        )
        r.raise_for_status()
        data = sorted(r.json().get("data", []), key=lambda d: d.get("index", 0))
        out.extend(d["embedding"] for d in data)
    return out


def embed_query(text: str) -> list[float]:
    vecs = embed_texts([text])
    if not vecs:
        raise RuntimeError("Embedding-Endpoint lieferte keinen Vektor zurück")
    return vecs[0]


def list_embed_models(base_url: str | None = None, api_key: str | None = None) -> list[str]:
    cfg = get_rag_config()
    base = (base_url or cfg["base_url"]).rstrip("/")
    key = api_key if api_key is not None else cfg["api_key"]
    r = httpx.get(f"{base}/models", headers=_auth_headers(key), timeout=8)
    r.raise_for_status()
    return [m.get("id") for m in r.json().get("data", []) if m.get("id")]


def test_connection(base_url: str | None = None, api_key: str | None = None) -> dict:
    try:
        models = list_embed_models(base_url, api_key)
        return {"ok": True, "models": models}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


# --- chunking --------------------------------------------------------------
def _split_overlapping(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP):
    """Yield (text, char_start, char_end) windows over a long string."""
    text = text.strip()
    if not text:
        return
    if len(text) <= size:
        yield text, 0, len(text)
        return
    step = max(1, size - overlap)
    i = 0
    while i < len(text):
        piece = text[i : i + size]
        yield piece.strip(), i, min(i + size, len(text))
        if i + size >= len(text):
            break
        i += step


def chunk_transcript(utterances) -> list[dict]:
    """Group speaker utterances into retrieval passages carrying time + speaker.

    Utterances are accumulated until the character budget is reached, then flushed
    as one passage spanning their combined time range.
    """
    chunks: list[dict] = []
    buf: list = []
    buf_len = 0

    def _line(u) -> str:
        return f"{u.speaker}: {u.text}" if u.speaker else u.text

    def flush():
        nonlocal buf, buf_len
        if not buf:
            return
        text = "\n".join(_line(u) for u in buf).strip()
        speakers = sorted({u.speaker for u in buf if u.speaker})
        chunks.append(
            {
                "text": text,
                "start_sec": buf[0].start,
                "end_sec": buf[-1].end,
                "speaker": ", ".join(speakers) or None,
            }
        )
        buf, buf_len = [], 0

    for u in utterances:
        line = _line(u)
        # A single very long utterance is hard-split on its own.
        if len(line) > CHUNK_CHARS:
            flush()
            for piece, _s, _e in _split_overlapping(u.text):
                chunks.append(
                    {
                        "text": f"{u.speaker}: {piece}" if u.speaker else piece,
                        "start_sec": u.start,
                        "end_sec": u.end,
                        "speaker": u.speaker or None,
                    }
                )
            continue
        if buf_len + len(line) > CHUNK_CHARS and buf:
            flush()
        buf.append(u)
        buf_len += len(line) + 1
    flush()
    return chunks


def chunk_summary(content: str) -> list[dict]:
    """Split a summary's markdown into passages on blank-line boundaries."""
    content = (content or "").strip()
    if not content:
        return []
    paras = [p.strip() for p in content.split("\n\n") if p.strip()]
    chunks: list[dict] = []
    buf = ""
    for para in paras:
        if len(para) > CHUNK_CHARS:
            if buf:
                chunks.append({"text": buf.strip()})
                buf = ""
            for piece, _s, _e in _split_overlapping(para):
                chunks.append({"text": piece})
            continue
        if len(buf) + len(para) + 2 > CHUNK_CHARS and buf:
            chunks.append({"text": buf.strip()})
            buf = ""
        buf += para + "\n\n"
    if buf.strip():
        chunks.append({"text": buf.strip()})
    return chunks


def chunk_document(content: str) -> list[dict]:
    """Split an uploaded document's extracted text into retrieval passages.

    Same paragraph-boundary strategy as summaries; long paragraphs (common in
    PDF extractions) are hard-split with overlap.
    """
    return chunk_summary(content)


# --- transcript assembly (utterances with timing) -------------------------
def load_utterances(session: Session, recording_id: int):
    """Speaker-annotated utterances for a recording (overlay applied)."""
    from .ml.diarization import SpeakerSegment
    from .overlay import load_overlay
    from .ml.alignment import build_utterances

    transcript = session.exec(
        select(Transcript).where(Transcript.recording_id == recording_id)
    ).first()
    if not transcript:
        return []
    words = session.exec(
        select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
    ).all()
    if not words:
        return []
    run = session.exec(
        select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id,
            DiarizationRun.is_active == True,  # noqa: E712
        )
    ).first()
    if not run:
        from .ml.alignment import Utterance

        text = "".join(w.text for w in words).strip()
        return [Utterance(speaker="", start=words[0].start, end=words[-1].end, text=text)]

    segs = session.exec(
        select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)
    ).all()
    aligned = [SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker_label) for s in segs]
    relabel, reassigns = load_overlay(session, recording_id)
    labels = session.exec(
        select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}
    utts = build_utterances(words, aligned, reassigns, relabel)
    for u in utts:
        u.speaker = name_map.get(u.speaker, u.speaker)
    return utts


# --- indexing --------------------------------------------------------------
def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def index_recording(session: Session, recording_id: int, progress=None) -> int:
    """(Re)build the RAG index for one recording. Returns chunk count written."""
    import sqlite_vec

    cfg = get_rag_config()
    dim = cfg["dimension"]
    rec = session.get(Recording, recording_id)
    if not rec:
        return 0

    # Phase 1 — read source content (read-only snapshot, no write lock held).
    topic_id = rec.topic_id
    pending: list[dict] = []
    for ch in chunk_transcript(load_utterances(session, recording_id)):
        ch["source_type"] = "transcript"
        ch["summary_id"] = None
        pending.append(ch)
    summaries = session.exec(
        select(Summary).where(Summary.recording_id == recording_id)
    ).all()
    for summ in summaries:
        for ch in chunk_summary(summ.content):
            ch["source_type"] = "summary"
            ch["summary_id"] = summ.id
            pending.append(ch)

    if not pending:
        _delete_recording_chunks(session, recording_id)
        session.commit()
        if progress:
            progress(1.0)
        return 0

    # Phase 2 — compute embeddings *before* opening a write transaction. This is
    # the slow part (network call to the embedding server); holding a SQLite write
    # lock across it would block the job-progress writer ("database is locked").
    if progress:
        progress(0.1)
    embeddings = embed_texts([c["text"] for c in pending])
    if embeddings and len(embeddings[0]) != dim:
        raise RuntimeError(
            f"Embedding-Dimension {len(embeddings[0])} passt nicht zur Konfiguration "
            f"({dim}). Bitte Dimension in den RAG-Einstellungen anpassen."
        )
    if progress:
        progress(0.6)

    # Phase 3 — short write burst (no progress writes while the lock is held).
    _delete_recording_chunks(session, recording_id)
    conn = session.connection()
    for i, (ch, vec) in enumerate(zip(pending, embeddings)):
        row = RagChunk(
            recording_id=recording_id,
            topic_id=topic_id,
            summary_id=ch.get("summary_id"),
            source_type=ch["source_type"],
            chunk_index=i,
            text=ch["text"],
            start_sec=ch.get("start_sec"),
            end_sec=ch.get("end_sec"),
            speaker=ch.get("speaker"),
            content_hash=_hash(ch["text"]),
            embed_model=cfg["model"],
        )
        session.add(row)
        session.flush()  # assigns row.id
        conn.exec_driver_sql(
            "INSERT INTO rag_chunk_vec(rowid, embedding, topic_id, recording_id) "
            "VALUES (?, ?, ?, ?)",
            (row.id, sqlite_vec.serialize_float32(vec), topic_id, recording_id),
        )
        _fts_insert(conn, row.id, row.text)
    session.commit()
    return len(pending)


def index_document(session: Session, document_id: int, progress=None) -> int:
    """(Re)build the RAG index for one uploaded document. Returns chunk count.

    Mirrors :func:`index_recording`: extract + chunk + embed *before* opening a
    write transaction (the embed call is a slow network round-trip), then a
    short write burst. Topic-level documents have no ``recording_id``; the vec0
    metadata column stores ``0`` for them so recording-filtered KNN (which
    matches a real id ≥ 1) never returns them.
    """
    import sqlite_vec

    from .documents import extract_text

    cfg = get_rag_config()
    dim = cfg["dimension"]
    doc = session.get(Document, document_id)
    if not doc:
        return 0

    from pathlib import Path

    text = extract_text(Path(doc.file_path), doc.content_type)
    pending = chunk_document(text)
    if not pending:
        _delete_document_chunks(session, document_id)
        doc.text_chars = len(text)
        session.add(doc)
        session.commit()
        if progress:
            progress(1.0)
        return 0

    if progress:
        progress(0.1)
    embeddings = embed_texts([c["text"] for c in pending])
    if embeddings and len(embeddings[0]) != dim:
        raise RuntimeError(
            f"Embedding-Dimension {len(embeddings[0])} passt nicht zur Konfiguration "
            f"({dim}). Bitte Dimension in den RAG-Einstellungen anpassen."
        )
    if progress:
        progress(0.6)

    _delete_document_chunks(session, document_id)
    topic_id = doc.topic_id
    recording_id = doc.recording_id
    vec_recording_id = recording_id if recording_id is not None else 0
    conn = session.connection()
    for i, (ch, vec) in enumerate(zip(pending, embeddings)):
        row = RagChunk(
            recording_id=recording_id,
            topic_id=topic_id,
            summary_id=None,
            document_id=document_id,
            source_type="document",
            chunk_index=i,
            text=ch["text"],
            content_hash=_hash(ch["text"]),
            embed_model=cfg["model"],
        )
        session.add(row)
        session.flush()  # assigns row.id
        conn.exec_driver_sql(
            "INSERT INTO rag_chunk_vec(rowid, embedding, topic_id, recording_id) "
            "VALUES (?, ?, ?, ?)",
            (row.id, sqlite_vec.serialize_float32(vec), topic_id, vec_recording_id),
        )
        _fts_insert(conn, row.id, row.text)
    doc.text_chars = len(text)
    session.add(doc)
    session.commit()
    return len(pending)


def _fts_insert(conn, rowid: int, text: str) -> None:
    from .db import fts_available

    if fts_available():
        conn.exec_driver_sql(
            "INSERT INTO rag_chunk_fts(rowid, text) VALUES (?, ?)", (rowid, text)
        )


def _fts_delete(conn, rowids: list[int]) -> None:
    from .db import fts_available

    if fts_available() and rowids:
        placeholders = ",".join("?" for _ in rowids)
        conn.exec_driver_sql(
            f"DELETE FROM rag_chunk_fts WHERE rowid IN ({placeholders})", tuple(rowids)
        )


def _delete_recording_chunks(session: Session, recording_id: int) -> None:
    conn = session.connection()
    conn.exec_driver_sql(
        "DELETE FROM rag_chunk_vec WHERE recording_id = ?", (recording_id,)
    )
    rows = session.exec(
        select(RagChunk).where(RagChunk.recording_id == recording_id)
    ).all()
    _fts_delete(conn, [row.id for row in rows])
    for row in rows:
        session.delete(row)
    session.flush()


def delete_recording_index(session: Session, recording_id: int) -> None:
    """Public hook used when a recording is deleted."""
    _delete_recording_chunks(session, recording_id)
    session.commit()


def delete_summary_index(session: Session, summary_id: int) -> None:
    """Remove a summary's chunks (+ vec rows) before the summary itself is deleted.

    RagChunk.summary_id is a FK to summaries; without this, deleting an indexed
    summary fails with a foreign-key constraint error.
    """
    conn = session.connection()
    rows = session.exec(
        select(RagChunk).where(RagChunk.summary_id == summary_id)
    ).all()
    _fts_delete(conn, [row.id for row in rows])
    for row in rows:
        conn.exec_driver_sql("DELETE FROM rag_chunk_vec WHERE rowid = ?", (row.id,))
        session.delete(row)
    session.flush()


def _delete_document_chunks(session: Session, document_id: int) -> None:
    conn = session.connection()
    rows = session.exec(
        select(RagChunk).where(RagChunk.document_id == document_id)
    ).all()
    _fts_delete(conn, [row.id for row in rows])
    for row in rows:
        conn.exec_driver_sql("DELETE FROM rag_chunk_vec WHERE rowid = ?", (row.id,))
        session.delete(row)
    session.flush()


def delete_document_index(session: Session, document_id: int) -> None:
    """Public hook used when a document is deleted."""
    _delete_document_chunks(session, document_id)
    session.commit()


# --- retrieval -------------------------------------------------------------
RRF_K = 60  # standard reciprocal-rank-fusion constant


def _vector_ranks(
    conn, query: str, k: int, topic_id: int | None, recording_id: int | None
) -> tuple[dict[int, int], dict[int, float]]:
    """KNN search → ({chunk_id: rank}, {chunk_id: distance})."""
    import sqlite_vec

    qvec = sqlite_vec.serialize_float32(embed_query(query))
    sql = "SELECT rowid, distance FROM rag_chunk_vec WHERE embedding MATCH ? AND k = ?"
    params: list = [qvec, k]
    if topic_id is not None:
        sql += " AND topic_id = ?"
        params.append(topic_id)
    if recording_id is not None:
        sql += " AND recording_id = ?"
        params.append(recording_id)
    rows = conn.exec_driver_sql(sql, tuple(params)).fetchall()
    ranks = {int(rowid): rank for rank, (rowid, _d) in enumerate(rows)}
    distances = {int(rowid): float(d) for rowid, d in rows}
    return ranks, distances


def _fts_match_query(query: str) -> str:
    """Sanitize free text into an FTS5 OR-query of quoted tokens."""
    import re

    tokens = re.findall(r"\w+", query, re.UNICODE)
    return " OR ".join(f'"{t}"' for t in tokens[:24])


def _fts_ranks(
    conn, query: str, k: int, topic_id: int | None, recording_id: int | None
) -> dict[int, int]:
    """BM25 keyword search → {chunk_id: rank}. Empty when FTS is unavailable."""
    from .db import fts_available

    if not fts_available():
        return {}
    match = _fts_match_query(query)
    if not match:
        return {}
    sql = (
        "SELECT f.rowid FROM rag_chunk_fts f JOIN rag_chunks c ON c.id = f.rowid "
        "WHERE rag_chunk_fts MATCH ?"
    )
    params: list = [match]
    if topic_id is not None:
        sql += " AND c.topic_id = ?"
        params.append(topic_id)
    if recording_id is not None:
        sql += " AND c.recording_id = ?"
        params.append(recording_id)
    sql += " ORDER BY rank LIMIT ?"
    params.append(k)
    rows = conn.exec_driver_sql(sql, tuple(params)).fetchall()
    return {int(row[0]): rank for rank, row in enumerate(rows)}


def search(
    session: Session,
    query: str,
    top_k: int | None = None,
    topic_id: int | None = None,
    recording_id: int | None = None,
    speaker: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict]:
    """Hybrid retrieval: semantic KNN + FTS5 keyword search, fused via RRF.

    Falls back to keyword-only when the embedding endpoint is unreachable (and
    vice versa). ``speaker`` and ``date_from``/``date_to`` (ISO dates) are
    post-filters on the fused result.
    """
    cfg = get_rag_config()
    k = top_k or cfg["top_k"]
    extra_filters = bool(speaker or date_from or date_to)
    fetch_k = k * (4 if extra_filters else 2)
    conn = session.connection()

    vec_err: Exception | None = None
    try:
        vec_ranks, distances = _vector_ranks(conn, query, fetch_k, topic_id, recording_id)
    except Exception as exc:  # noqa: BLE001 - embedding server down → keyword-only
        vec_ranks, distances = {}, {}
        vec_err = exc
    fts_ranks = _fts_ranks(conn, query, fetch_k, topic_id, recording_id)
    if not vec_ranks and not fts_ranks and vec_err is not None:
        raise vec_err

    scores: dict[int, float] = {}
    for ranks in (vec_ranks, fts_ranks):
        for chunk_id, rank in ranks.items():
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank + 1)

    ordered = sorted(scores.items(), key=lambda kv: -kv[1])

    hits: list[dict] = []
    speaker_lc = speaker.lower() if speaker else None
    for chunk_id, score in ordered:
        chunk = session.get(RagChunk, chunk_id)
        if not chunk:
            continue
        rec = session.get(Recording, chunk.recording_id) if chunk.recording_id else None
        if speaker_lc and speaker_lc not in (chunk.speaker or "").lower():
            continue
        if (date_from or date_to) and rec:
            rec_date = rec.created_at.strftime("%Y-%m-%d")
            if date_from and rec_date < date_from:
                continue
            if date_to and rec_date > date_to:
                continue
        # For document chunks the display title is the document's own title
        # (recording_title is reused so existing source rendering still works).
        title = rec.title if rec else ""
        if chunk.source_type == "document" and chunk.document_id:
            doc = session.get(Document, chunk.document_id)
            if doc:
                title = doc.title
        hits.append(
            {
                "chunk_id": chunk.id,
                "recording_id": chunk.recording_id,
                "recording_title": title,
                "topic_id": chunk.topic_id,
                "document_id": chunk.document_id,
                "source_type": chunk.source_type,
                "text": chunk.text,
                "start_sec": chunk.start_sec,
                "end_sec": chunk.end_sec,
                "speaker": chunk.speaker,
                "distance": distances.get(chunk_id),
                "score": round(score, 6),
            }
        )
        if len(hits) >= k:
            break
    return hits


def index_stats(session: Session) -> dict:
    from sqlalchemy import func

    total = session.exec(select(func.count(RagChunk.id))).one()
    recordings = session.exec(
        select(func.count(func.distinct(RagChunk.recording_id)))
    ).one()
    cfg = get_rag_config()
    return {
        "chunks": int(total),
        "recordings_indexed": int(recordings),
        "model": cfg["model"],
        "dimension": cfg["dimension"],
    }

"""RAG config, index status/reindex, and the retrieval-augmented chat endpoint."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session

from .. import llm as L
from .. import rag as R
from ..db import get_session, vec_available
from ..models import Recording
from ..security import require_token
from ..settings_store import (
    has_rag_api_key,
    load_prefs,
    save_prefs,
    set_rag_api_key,
)

router = APIRouter(prefix="/api/rag", tags=["rag"], dependencies=[Depends(require_token)])


class RagConfigIn(BaseModel):
    base_url: str | None = None
    model: str | None = None
    dimension: int | None = None
    top_k: int | None = None
    enabled: bool | None = None


class RagApiKeyIn(BaseModel):
    api_key: str
    base_url: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: list[ChatMessage]
    topic_id: int | None = None
    recording_id: int | None = None
    top_k: int | None = None
    speaker: str | None = None
    date_from: str | None = None  # ISO date YYYY-MM-DD
    date_to: str | None = None


class SearchIn(BaseModel):
    query: str
    topic_id: int | None = None
    recording_id: int | None = None
    top_k: int | None = None
    speaker: str | None = None
    date_from: str | None = None
    date_to: str | None = None


SYSTEM_PROMPT = (
    "Du bist der Wissensassistent von Tarscribe. Beantworte Fragen ausschließlich "
    "auf Basis der bereitgestellten Kontext-Ausschnitte aus Transkripten und "
    "Zusammenfassungen. Zitiere die genutzten Quellen mit [n]. Wenn der Kontext die "
    "Antwort nicht hergibt, sage das ehrlich."
)


@router.get("/config")
def get_config() -> dict:
    rag = load_prefs().get("rag") or {}
    return {
        **rag,
        "enabled": bool(load_prefs().get("rag_enabled")),
        "api_key_set": has_rag_api_key(),
        "vec_available": vec_available(),
    }


@router.put("/config")
def set_config(payload: RagConfigIn, session: Session = Depends(get_session)) -> dict:
    data = payload.model_dump(exclude_unset=True)
    patch: dict = {}
    if "enabled" in data:
        patch["rag_enabled"] = bool(data.pop("enabled"))
    if data:
        rag = dict(load_prefs().get("rag") or {})
        rag.update(data)
        patch["rag"] = rag
    if patch:
        save_prefs(patch)

    # If the embedding model or dimension changed, the old vectors are unusable:
    # the index is wiped and re-indexed automatically so it never silently empties.
    reindexing = 0
    from sqlmodel import select

    from ..db import _ensure_vec_table

    if vec_available() and _ensure_vec_table() and R.rag_enabled():
        from ..jobs import enqueue_embedding

        rec_ids = session.exec(select(Recording.id)).all()
        reindexing = len([j for j in (enqueue_embedding(r) for r in rec_ids) if j is not None])
    return {**get_config(), "reindexing": reindexing}


@router.get("/models")
def list_models(base_url: str | None = None) -> dict:
    try:
        return {"models": R.list_embed_models(base_url)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Embedding-Server nicht erreichbar: {exc}") from exc


@router.post("/test")
def test(payload: RagConfigIn) -> dict:
    return R.test_connection(payload.base_url)


@router.put("/api-key")
def set_api_key(payload: RagApiKeyIn) -> dict:
    key = payload.api_key.strip()
    set_rag_api_key(key or None)
    if not key:
        return {"saved": True, "api_key_set": False}
    try:
        models = R.list_embed_models(payload.base_url, api_key=key)
        return {"saved": True, "ok": True, "models": models, "api_key_set": True}
    except Exception as exc:  # noqa: BLE001
        return {"saved": True, "ok": False, "error": str(exc), "api_key_set": True}


@router.delete("/api-key")
def delete_api_key() -> dict:
    set_rag_api_key(None)
    return {"saved": True, "api_key_set": False}


@router.get("/status")
def status(session: Session = Depends(get_session)) -> dict:
    if not vec_available():
        return {"vec_available": False, "chunks": 0, "recordings_indexed": 0}
    return {"vec_available": True, **R.index_stats(session)}


@router.post("/reindex")
def reindex(session: Session = Depends(get_session)) -> dict:
    """Enqueue a (re)index job for every recording that has a transcript."""
    if not R.rag_enabled():
        raise HTTPException(400, "RAG ist deaktiviert oder sqlite-vec nicht verfügbar.")
    from ..jobs import enqueue_embedding
    from sqlmodel import select

    recs = session.exec(select(Recording.id)).all()
    enqueued = [enqueue_embedding(rid) for rid in recs]
    return {"enqueued": len([j for j in enqueued if j is not None])}


@router.post("/search")
def semantic_search(payload: SearchIn, session: Session = Depends(get_session)) -> dict:
    """Pure semantic retrieval (no LLM) — usable without a chat model configured."""
    if not R.rag_enabled():
        raise HTTPException(400, "RAG ist deaktiviert oder sqlite-vec nicht verfügbar.")
    if not payload.query.strip():
        return {"hits": []}
    try:
        hits = R.search(
            session,
            payload.query,
            top_k=payload.top_k,
            topic_id=payload.topic_id,
            recording_id=payload.recording_id,
            speaker=payload.speaker,
            date_from=payload.date_from,
            date_to=payload.date_to,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Suche fehlgeschlagen: {exc}") from exc
    return {"hits": hits}


@router.post("/chat")
def chat(payload: ChatIn, session: Session = Depends(get_session)) -> StreamingResponse:
    if not R.rag_enabled():
        raise HTTPException(400, "RAG ist deaktiviert oder sqlite-vec nicht verfügbar.")
    if not payload.messages:
        raise HTTPException(400, "Keine Nachricht übergeben.")

    cfg = L.get_llm_config()
    if not cfg["model"]:
        raise HTTPException(400, "Kein Chat-LLM konfiguriert (siehe LLM-Einstellungen).")

    query = payload.messages[-1].content
    try:
        hits = R.search(
            session,
            query,
            top_k=payload.top_k,
            topic_id=payload.topic_id,
            recording_id=payload.recording_id,
            speaker=payload.speaker,
            date_from=payload.date_from,
            date_to=payload.date_to,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Retrieval fehlgeschlagen: {exc}") from exc

    # Build a numbered context block + the public source list (sans full text).
    context_lines: list[str] = []
    sources: list[dict] = []
    for i, h in enumerate(hits, start=1):
        ts = f" @ {int(h['start_sec'])}s" if h.get("start_sec") is not None else ""
        context_lines.append(
            f"[{i}] {h['recording_title']}{ts} ({h['source_type']}):\n{h['text']}"
        )
        sources.append(
            {
                "index": i,
                "recording_id": h["recording_id"],
                "recording_title": h["recording_title"],
                "source_type": h["source_type"],
                "start_sec": h.get("start_sec"),
                "end_sec": h.get("end_sec"),
                "speaker": h.get("speaker"),
                "text": h["text"],
            }
        )
    context = "\n\n".join(context_lines) if context_lines else "(keine relevanten Ausschnitte gefunden)"

    history = [{"role": m.role, "content": m.content} for m in payload.messages[:-1]]
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history,
        {"role": "user", "content": f"Kontext:\n{context}\n\nFrage: {query}"},
    ]

    def gen():
        yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"
        try:
            for delta in L.stream_chat(
                messages,
                cfg["model"],
                cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
            ):
                yield f"data: {json.dumps({'type': 'delta', 'content': delta})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")

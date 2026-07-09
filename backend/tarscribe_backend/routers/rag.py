"""RAG config, index status/reindex, and the retrieval-augmented chat endpoint."""

from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session

from .. import llm as L
from .. import agent as AG
from .. import rag as R
from .. import settings_store
from ..db import get_session, vec_available
from ..models import Recording

router = APIRouter(prefix="/api/rag", tags=["rag"])


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


ReasoningEffort = Literal["minimal", "low", "medium", "high"]


class ChatIn(BaseModel):
    messages: list[ChatMessage]
    topic_id: int | None = None
    recording_id: int | None = None
    include_topic_context: bool = False
    reasoning_effort: ReasoningEffort | None = None
    top_k: int | None = None
    speaker: str | None = None
    date_from: str | None = None  # ISO date YYYY-MM-DD
    date_to: str | None = None


class SearchIn(BaseModel):
    query: str
    topic_id: int | None = None
    recording_id: int | None = None
    include_topic_context: bool = False
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
    rag = settings_store.load_prefs().get("rag") or {}
    return {
        **rag,
        "enabled": bool(settings_store.load_prefs().get("rag_enabled")),
        "api_key_set": settings_store.has_rag_api_key(),
        "vec_available": vec_available(),
    }


@router.put("/config")
def set_config(payload: RagConfigIn, session: Session = Depends(get_session)) -> dict:
    data = payload.model_dump(exclude_unset=True)
    patch: dict = {}
    if "enabled" in data:
        patch["rag_enabled"] = bool(data.pop("enabled"))
    if data:
        rag = dict(settings_store.load_prefs().get("rag") or {})
        rag.update(data)
        patch["rag"] = rag
    if patch:
        settings_store.save_prefs(patch)

    # If the embedding model or dimension changed, the old vectors are unusable:
    # the index is wiped and re-indexed automatically so it never silently empties.
    reindexing = 0
    from sqlmodel import select

    from ..db import _ensure_vec_table

    if vec_available() and _ensure_vec_table() and R.rag_enabled():
        from ..jobs import enqueue_document_embedding, enqueue_embedding
        from ..models import Document

        rec_ids = session.exec(select(Recording.id)).all()
        reindexing = len([j for j in (enqueue_embedding(r) for r in rec_ids) if j is not None])
        doc_ids = session.exec(select(Document.id)).all()
        reindexing += len(
            [j for j in (enqueue_document_embedding(d) for d in doc_ids) if j is not None]
        )
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
    try:
        settings_store.set_rag_api_key(key or None)
    except settings_store.SecretStorageUnavailable as exc:
        raise HTTPException(503, "Sicherer Secret-Speicher ist nicht verfügbar") from exc
    if not key:
        return {"saved": True, "api_key_set": False}
    try:
        models = R.list_embed_models(payload.base_url, api_key=key)
        return {"saved": True, "ok": True, "models": models, "api_key_set": True}
    except Exception as exc:  # noqa: BLE001
        return {"saved": True, "ok": False, "error": str(exc), "api_key_set": True}


@router.delete("/api-key")
def delete_api_key() -> dict:
    try:
        settings_store.set_rag_api_key(None)
    except settings_store.SecretStorageUnavailable as exc:
        raise HTTPException(503, "Sicherer Secret-Speicher ist nicht verfügbar") from exc
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
    from ..jobs import enqueue_document_embedding, enqueue_embedding
    from sqlmodel import select

    from ..models import Document

    recs = session.exec(select(Recording.id)).all()
    enqueued = [enqueue_embedding(rid) for rid in recs]
    docs = session.exec(select(Document.id)).all()
    enqueued += [enqueue_document_embedding(did) for did in docs]
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
            include_topic_context=payload.include_topic_context,
            speaker=payload.speaker,
            date_from=payload.date_from,
            date_to=payload.date_to,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Suche fehlgeschlagen: {exc}") from exc
    return {"hits": hits}


@router.post("/chat")
async def chat(payload: ChatIn, session: Session = Depends(get_session)) -> StreamingResponse:
    if not R.rag_enabled():
        raise HTTPException(400, "RAG ist deaktiviert oder sqlite-vec nicht verfügbar.")
    if not payload.messages:
        raise HTTPException(400, "Keine Nachricht übergeben.")

    cfg = L.get_llm_config("chat")
    if not cfg["model"]:
        raise HTTPException(400, "Kein Chat-Modell konfiguriert (siehe Einstellungen).")

    query = payload.messages[-1].content
    try:
        hits = R.search(
            session,
            query,
            top_k=payload.top_k,
            topic_id=payload.topic_id,
            recording_id=payload.recording_id,
            include_topic_context=payload.include_topic_context,
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
                "topic_id": h.get("topic_id"),
                "document_id": h.get("document_id"),
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

    agent_cfg = AG.get_agent_rag_config("chat")
    agent_enabled = bool(agent_cfg["enabled"] and agent_cfg["rag_enabled"] and agent_cfg["model"])
    agent_topic_id = payload.topic_id
    if agent_enabled and payload.recording_id is not None and payload.include_topic_context:
        recording = session.get(Recording, payload.recording_id)
        if recording is not None:
            agent_topic_id = recording.topic_id
    agent_messages_seed = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history,
        {"role": "user", "content": query},
    ]

    async def run_agent_research(queue: asyncio.Queue[dict]) -> tuple[str, list[dict]]:
        if not agent_enabled:
            return "", []

        def broadcast(event: dict) -> None:
            queue.put_nowait({"type": "agent_research", **event})

        try:
            return await AG.research_context(
                session=session,
                topic_id=agent_topic_id,
                recording_id=payload.recording_id,
                task_description=f"Wissensfrage beantworten: {query}",
                messages_seed=agent_messages_seed,
                cfg=agent_cfg,
                broadcast_fn=broadcast,
            )
        except AG.ToolSupportError:
            return "", []
        except Exception:  # noqa: BLE001
            return "", []

    async def gen():
        final_sources = [dict(source) for source in sources]
        final_messages = [dict(message) for message in messages]

        if agent_enabled:
            research_events: asyncio.Queue[dict] = asyncio.Queue()
            research_task = asyncio.create_task(run_agent_research(research_events))
            while not research_task.done() or not research_events.empty():
                try:
                    event = await asyncio.wait_for(research_events.get(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

            _research_notes, research_sources = await research_task
            known_texts = {source["text"] for source in final_sources}
            agent_context_lines: list[str] = []
            for source in research_sources:
                text = (source.get("text") or "").strip()
                if not text or text in known_texts:
                    continue
                known_texts.add(text)
                index = len(final_sources) + 1
                normalized = {
                    "index": index,
                    "recording_id": source.get("recording_id"),
                    "recording_title": source.get("recording_title") or "Quelle",
                    "topic_id": source.get("topic_id"),
                    "document_id": source.get("document_id"),
                    "source_type": source.get("source_type") or "transcript",
                    "source_url": source.get("source_url"),
                    "start_sec": source.get("start_sec"),
                    "end_sec": source.get("end_sec"),
                    "speaker": source.get("speaker"),
                    "text": text,
                }
                final_sources.append(normalized)
                agent_context_lines.append(
                    f"[{index}] {normalized['recording_title']} "
                    f"({normalized['source_type']}):\n{text}"
                )
            if agent_context_lines:
                final_messages[-1]["content"] += (
                    "\n\n--- Zusätzlich agentisch recherchierter Kontext ---\n"
                    + "\n\n".join(agent_context_lines)
                )

        yield f"data: {json.dumps({'type': 'sources', 'sources': final_sources})}\n\n"
        try:
            for delta in L.stream_chat(
                final_messages,
                cfg["model"],
                cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=(
                    payload.reasoning_effort or cfg.get("reasoning_effort")
                ),
                provider=cfg.get("provider"),
            ):
                yield f"data: {json.dumps({'type': 'delta', 'content': delta})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")

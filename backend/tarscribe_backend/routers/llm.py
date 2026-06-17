"""LLM server config, model listing, and summarization endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import llm as L
from ..db import get_session
from ..jobs import enqueue_summary
from ..models import Recording, Summary, SummaryTemplate
from ..security import require_token
from ..settings_store import (
    has_llm_api_key,
    load_prefs,
    save_prefs,
    set_llm_api_key,
)

router = APIRouter(tags=["llm"], dependencies=[Depends(require_token)])


class LlmConfigIn(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    max_tokens: int | None = None
    reasoning_effort: str | None = None


class LlmApiKeyIn(BaseModel):
    api_key: str
    base_url: str | None = None


@router.get("/api/llm/config")
def get_llm_config() -> dict:
    # The API key itself is a secret and never leaves the keychain; expose only
    # whether one is stored.
    return {**(load_prefs().get("llm") or {}), "api_key_set": has_llm_api_key()}


@router.put("/api/llm/config")
def set_llm_config(payload: LlmConfigIn) -> dict:
    llm = dict(load_prefs().get("llm") or {})
    # exclude_unset=True: only touch fields the client explicitly sent
    # (allows sending null to clear a param)
    llm.update(payload.model_dump(exclude_unset=True))
    save_prefs({"llm": llm})
    return {**llm, "api_key_set": has_llm_api_key()}


@router.get("/api/llm/models")
def list_models(base_url: str | None = None) -> dict:
    try:
        return {"models": L.list_models(base_url)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"LLM-Server nicht erreichbar: {exc}") from exc


@router.post("/api/llm/test")
def test(payload: LlmConfigIn) -> dict:
    return L.test_connection(payload.base_url)


@router.put("/api/llm/api-key")
def set_api_key(payload: LlmApiKeyIn) -> dict:
    """Store the (secret) API key in the keychain and verify it by listing models."""
    key = payload.api_key.strip()
    set_llm_api_key(key or None)
    if not key:
        return {"saved": True, "api_key_set": False}
    try:
        models = L.list_models(payload.base_url, api_key=key)
        return {"saved": True, "ok": True, "models": models, "api_key_set": True}
    except Exception as exc:  # noqa: BLE001
        # Stored regardless (may be a transient network error); report status.
        return {"saved": True, "ok": False, "error": str(exc), "api_key_set": True}


@router.delete("/api/llm/api-key")
def delete_api_key() -> dict:
    set_llm_api_key(None)
    return {"saved": True, "api_key_set": False}


@router.post("/api/recordings/{recording_id}/summarize")
def summarize(
    recording_id: int, template_id: int, session: Session = Depends(get_session)
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    tpl = session.get(SummaryTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Vorlage nicht gefunden")

    cfg = L.get_llm_config()
    summary = Summary(recording_id=recording_id, template_id=template_id, model=cfg["model"] or "")
    session.add(summary)
    session.commit()
    session.refresh(summary)

    job_id = enqueue_summary(recording_id, template_id, summary.id)
    return {"job_id": job_id, "summary_id": summary.id}


@router.get("/api/recordings/{recording_id}/summaries")
def list_summaries(recording_id: int, session: Session = Depends(get_session)) -> list[Summary]:
    return list(
        session.exec(
            select(Summary)
            .where(Summary.recording_id == recording_id)
            .order_by(Summary.created_at.desc())
        ).all()
    )


@router.get("/api/summaries/{summary_id}")
def get_summary(summary_id: int, session: Session = Depends(get_session)) -> Summary:
    summary = session.get(Summary, summary_id)
    if not summary:
        raise HTTPException(404, "Zusammenfassung nicht gefunden")
    return summary


@router.delete("/api/summaries/{summary_id}", status_code=204)
def delete_summary(summary_id: int, session: Session = Depends(get_session)) -> None:
    summ = session.get(Summary, summary_id)
    if summ:
        # Remove indexed chunks first — RagChunk.summary_id FK would block the delete.
        from ..db import vec_available

        if vec_available():
            from .. import rag

            rag.delete_summary_index(session, summary_id)
        session.delete(summ)
        session.commit()

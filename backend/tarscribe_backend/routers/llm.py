"""Chat model config, model listing, and summarization endpoints."""

from __future__ import annotations

from datetime import datetime, timezone
import unicodedata
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import llm as L
from .. import settings_store
from ..db import get_session
from ..jobs import enqueue_summary, schedule_reindex_debounced
from ..models import Recording, Summary, SummaryTemplate

router = APIRouter(tags=["llm"])


class LlmConfigIn(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    max_tokens: int | None = None
    reasoning_effort: str | None = None
    profiles: dict[str, dict] | None = None


class LlmApiKeyIn(BaseModel):
    api_key: str
    base_url: str | None = None


class SummarizeIn(BaseModel):
    clarification: str | None = Field(default=None, max_length=4000)


class SummaryUpdateIn(BaseModel):
    content: str = Field(max_length=1_000_000)
    revision: int = Field(ge=0)


@router.get("/api/llm/config")
def get_llm_config() -> dict:
    # The API key itself is a secret and never leaves the keychain; expose only
    # whether one is stored.
    return {
        **(settings_store.load_prefs().get("llm") or {}),
        "profiles": L.get_llm_profiles(),
        "api_key_set": settings_store.has_llm_api_key(),
    }


@router.put("/api/llm/config")
def set_llm_config(payload: LlmConfigIn) -> dict:
    llm = dict(settings_store.load_prefs().get("llm") or {})
    data = payload.model_dump(exclude_unset=True)
    profile_patch = data.pop("profiles", None)
    llm.update(data)
    if profile_patch is not None:
        profiles = dict(llm.get("profiles") or {})
        for use_case, patch in profile_patch.items():
            if use_case not in L.LLM_USE_CASES or not isinstance(patch, dict):
                continue
            profile = dict(profiles.get(use_case) or {})
            profile.update(
                {
                    key: value
                    for key, value in patch.items()
                    if key in {"model", "reasoning_effort", "agent_mode"}
                }
            )
            profiles[use_case] = profile
        llm["profiles"] = profiles
    settings_store.save_prefs({"llm": llm})
    return {
        **llm,
        "profiles": L.get_llm_profiles(),
        "api_key_set": settings_store.has_llm_api_key(),
    }


@router.get("/api/llm/models")
def list_models(base_url: str | None = None) -> dict:
    try:
        return {"models": L.list_models(base_url)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Chat-Endpoint nicht erreichbar: {exc}") from exc


@router.post("/api/llm/test")
def test(payload: LlmConfigIn) -> dict:
    return L.test_connection(payload.base_url)


@router.put("/api/llm/api-key")
def set_api_key(payload: LlmApiKeyIn) -> dict:
    """Store the (secret) API key in the keychain and verify it by listing models."""
    key = payload.api_key.strip()
    try:
        settings_store.set_llm_api_key(key or None)
    except settings_store.SecretStorageUnavailable as exc:
        raise HTTPException(503, "Sicherer Secret-Speicher ist nicht verfügbar") from exc
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
    try:
        settings_store.set_llm_api_key(None)
    except settings_store.SecretStorageUnavailable as exc:
        raise HTTPException(503, "Sicherer Secret-Speicher ist nicht verfügbar") from exc
    return {"saved": True, "api_key_set": False}


@router.post("/api/recordings/{recording_id}/summarize")
def summarize(
    recording_id: int,
    template_id: int,
    payload: SummarizeIn | None = None,
    session: Session = Depends(get_session),
) -> dict:
    rec = session.get(Recording, recording_id)
    if not rec:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    tpl = session.get(SummaryTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Vorlage nicht gefunden")

    cfg = L.get_llm_config("summaries")
    summary = Summary(recording_id=recording_id, template_id=template_id, model=cfg["model"] or "")
    session.add(summary)
    session.commit()
    session.refresh(summary)

    clarification = (payload.clarification or "").strip() if payload else ""
    job_id = enqueue_summary(recording_id, template_id, summary.id, clarification or None)
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


@router.patch("/api/summaries/{summary_id}")
def update_summary(
    summary_id: int,
    payload: SummaryUpdateIn,
    session: Session = Depends(get_session),
) -> Summary:
    summary = session.get(Summary, summary_id)
    if not summary:
        raise HTTPException(404, "Zusammenfassung nicht gefunden")
    if summary.revision != payload.revision:
        raise HTTPException(
            409,
            "Die Zusammenfassung wurde zwischenzeitlich geändert. Bitte neu laden.",
        )
    if summary.generated_content is None:
        summary.generated_content = summary.content
    summary.content = payload.content
    summary.revision += 1
    summary.updated_at = datetime.now(timezone.utc)
    session.add(summary)
    session.commit()
    session.refresh(summary)
    schedule_reindex_debounced(summary.recording_id)
    return summary


@router.get("/api/summaries/{summary_id}/export.pdf")
def export_summary_pdf(
    summary_id: int,
    session: Session = Depends(get_session),
) -> Response:
    summary = session.get(Summary, summary_id)
    if not summary:
        raise HTTPException(404, "Zusammenfassung nicht gefunden")
    if not summary.content.strip():
        raise HTTPException(409, "Die Zusammenfassung ist noch leer")
    recording = session.get(Recording, summary.recording_id)
    if not recording:
        raise HTTPException(404, "Aufnahme nicht gefunden")
    from ..summary_pdf import render_summary_pdf

    body = render_summary_pdf(summary.content, recording.title)
    display_name = "".join(
        char if char.isalnum() or char in " -_" else "_" for char in recording.title
    ).strip() or "Zusammenfassung"
    display_name = f"{display_name} - Zusammenfassung.pdf"
    safe = unicodedata.normalize("NFKD", display_name).encode("ascii", "ignore").decode()
    safe = safe.replace('"', "_") or "Zusammenfassung.pdf"
    return Response(
        body,
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(display_name)}'
            )
        },
    )


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

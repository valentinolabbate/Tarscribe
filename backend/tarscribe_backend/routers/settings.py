"""User settings: preferences and the HuggingFace token (secure)."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Literal

from ..security import require_token
from ..settings_store import (
    get_hf_token,
    has_hf_token,
    load_prefs,
    save_prefs,
    set_hf_token,
)

router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[Depends(require_token)])


class HfTokenIn(BaseModel):
    token: str


class PrefsIn(BaseModel):
    language: str | None = None
    asr_override: str | None = None
    recording_source: Literal["microphone", "system_audio", "system_audio_and_microphone"] | None = None
    recording_device_id: str | None = None
    diarization_model: str | None = None
    llm: dict | None = None
    speaker_match_threshold: float | None = None
    live_transcription_enabled: bool | None = None
    live_speaker_detection_enabled: bool | None = None
    llm_chunk_size: int | None = None
    digest_export_path: str | None = None
    dictation_shortcut: str | None = None
    meeting_detection_enabled: bool | None = None
    meeting_detection_apps: list[str] | None = None


@router.get("")
def get_settings_payload() -> dict:
    prefs = load_prefs()
    return {**prefs, "hf_token_set": has_hf_token()}


@router.put("")
def update_settings(payload: PrefsIn) -> dict:
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    prefs = save_prefs(patch)
    return {**prefs, "hf_token_set": has_hf_token()}


def _validate_hf_token(token: str) -> dict:
    """Call HF whoami; returns {valid, name?, error?}."""
    try:
        r = httpx.get(
            "https://huggingface.co/api/whoami-v2",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            return {"valid": True, "name": data.get("name") or data.get("fullname")}
        return {"valid": False, "error": f"HTTP {r.status_code}"}
    except Exception as exc:  # noqa: BLE001
        return {"valid": False, "error": str(exc)}


@router.put("/hf-token")
def set_token(payload: HfTokenIn) -> dict:
    result = _validate_hf_token(payload.token.strip())
    # Store even if validation fails for network reasons, but report status.
    set_hf_token(payload.token.strip())
    return {"saved": True, **result}


@router.post("/hf-token/validate")
def validate_token() -> dict:
    token = get_hf_token()
    if not token:
        return {"valid": False, "error": "Kein Token hinterlegt"}
    return _validate_hf_token(token)


@router.delete("/hf-token")
def delete_token() -> dict:
    set_hf_token(None)
    return {"saved": True, "hf_token_set": False}

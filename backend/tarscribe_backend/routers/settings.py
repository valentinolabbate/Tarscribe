"""User settings: preferences and the HuggingFace token (secure)."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Literal

from ..calendar_sync import test_caldav_connection
from ..security import require_token
from ..settings_store import (
    get_caldav_password,
    get_hf_token,
    has_caldav_password,
    has_hf_token,
    load_prefs,
    save_prefs,
    set_caldav_password,
    set_hf_token,
)

router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[Depends(require_token)])


class HfTokenIn(BaseModel):
    token: str


class CaldavPasswordIn(BaseModel):
    password: str


class CaldavTestIn(BaseModel):
    url: str | None = None
    username: str | None = None
    password: str | None = None


class PrefsIn(BaseModel):
    language: str | None = None
    performance_profile: Literal["m1_8gb", "balanced", "quality"] | None = None
    asr_override: str | None = None
    asr_model: str | None = None
    recording_source: Literal["microphone", "system_audio", "system_audio_and_microphone"] | None = None
    recording_device_id: str | None = None
    diarization_model: str | None = None
    llm: dict | None = None
    speaker_match_threshold: float | None = None
    my_speaker_id: int | None = None
    live_transcription_enabled: bool | None = None
    live_speaker_detection_enabled: bool | None = None
    llm_chunk_size: int | None = None
    summary_use_topic_knowledge: bool | None = None
    digest_export_path: str | None = None
    dictation_shortcut: str | None = None
    meeting_detection_enabled: bool | None = None
    meeting_detection_apps: list[str] | None = None
    caldav: dict | None = None


@router.get("")
def get_settings_payload() -> dict:
    prefs = load_prefs()
    return {**prefs, "hf_token_set": has_hf_token(), "caldav_password_set": has_caldav_password()}


@router.put("")
def update_settings(payload: PrefsIn) -> dict:
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    prefs = save_prefs(patch)
    return {**prefs, "hf_token_set": has_hf_token(), "caldav_password_set": has_caldav_password()}


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


@router.put("/caldav-password")
def set_caldav_secret(payload: CaldavPasswordIn) -> dict:
    set_caldav_password(payload.password.strip() or None)
    return {"saved": True, "caldav_password_set": has_caldav_password()}


@router.delete("/caldav-password")
def delete_caldav_secret() -> dict:
    set_caldav_password(None)
    return {"saved": True, "caldav_password_set": False}


@router.post("/caldav/test")
def test_caldav(payload: CaldavTestIn) -> dict:
    prefs = load_prefs()
    caldav = prefs.get("caldav") if isinstance(prefs.get("caldav"), dict) else {}
    url = payload.url if payload.url is not None else caldav.get("url", "")
    username = payload.username if payload.username is not None else caldav.get("username", "")
    password = payload.password if payload.password is not None else get_caldav_password()
    return test_caldav_connection(url or "", username or "", password)

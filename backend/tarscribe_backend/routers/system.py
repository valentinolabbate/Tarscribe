"""System endpoints used by the Tauri shell and first-run wizard.

All routes require the shared-secret token. The readiness probe lives at
``GET /api/health`` (see ``main.py``) and is intentionally unauthenticated so
the shell can poll before the token is available.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..hardware import detect_hardware
from ..media_tools import is_media_tool_available
from ..settings_store import has_hf_token, load_prefs, save_prefs, secret_storage_status

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/hardware")
def hardware() -> dict:
    info = detect_hardware().to_dict()
    info["ffmpeg_available"] = is_media_tool_available("ffmpeg")
    info["ffprobe_available"] = is_media_tool_available("ffprobe")
    return info


@router.get("/setup-status")
def setup_status() -> dict:
    prefs = load_prefs()
    llm = prefs.get("llm") or {}
    return {
        "setup_complete": bool(prefs.get("setup_complete")),
        "ffmpeg_available": is_media_tool_available("ffmpeg"),
        "hf_token_set": has_hf_token(),
        "llm_configured": bool(llm.get("model")),
        "secret_storage": secret_storage_status(),
        "hardware": detect_hardware().to_dict(),
    }


@router.get("/models")
def models() -> dict:
    from ..ml.model_status import model_status_payload

    return model_status_payload()


@router.post("/complete-setup")
def complete_setup() -> dict:
    save_prefs({"setup_complete": True})
    return {"setup_complete": True}


@router.post("/warmup")
def warmup() -> dict:
    """Load the ASR backend so its model downloads now (first-run prep)."""
    from ..ml.asr.factory import get_backend
    from ..ml.lifecycle import asr_lock

    # Serialize with real transcription jobs so first-run warmup can't load the
    # model a second time while a job is loading/using it.
    with asr_lock:
        backend = get_backend()
        # Touch the model loader (downloads on first call) without transcribing.
        if hasattr(backend, "_ensure_model"):
            backend._ensure_model()
    return {"ok": True, "engine": getattr(backend, "name", "unknown")}

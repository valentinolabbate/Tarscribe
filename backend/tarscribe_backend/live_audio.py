"""Legacy live-audio endpoint stubs.

Live PCM upload is handled by ``/api/live-recordings/{session_id}/chunks``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/live-audio", tags=["live-audio-legacy"])

_GONE = "Legacy-Live-Audio wurde entfernt. Nutze /api/live-recordings."
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


def _gone() -> None:
    raise HTTPException(status_code=410, detail=_GONE)


@router.api_route("", methods=_METHODS)
def legacy_live_audio_root() -> None:
    _gone()


@router.api_route("/{path:path}", methods=_METHODS)
def legacy_live_audio_path(path: str) -> None:
    _gone()

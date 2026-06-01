"""Shared-secret auth so only the local Tauri shell can talk to the sidecar."""

from __future__ import annotations

from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_token(x_tarscribe_token: str = Header(default="")) -> None:
    expected = get_settings().auth_token
    if not expected:  # auth disabled (e.g. tests)
        return
    if x_tarscribe_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Ungültiges oder fehlendes Auth-Token.",
        )

"""Shared-secret auth so only the local Tauri shell can talk to the sidecar."""

from __future__ import annotations

from fastapi import Cookie, Header, HTTPException, Request, status

from . import config
from .audit import audit_event
from .ws import auth_token_from_subprotocols


async def require_token(
    request: Request,
    x_tarscribe_token: str = Header(default=""),
    tarscribe_token: str = Cookie(default=""),
    sec_websocket_protocol: str = Header(default=""),
) -> None:
    expected = config.get_settings().auth_token
    if not expected:  # auth disabled (e.g. tests)
        return
    presented = (
        x_tarscribe_token
        or tarscribe_token
        or auth_token_from_subprotocols(sec_websocket_protocol)
    )
    if presented != expected:
        auth_source = (
            "header"
            if x_tarscribe_token
            else "cookie"
            if tarscribe_token
            else "websocket_subprotocol"
            if sec_websocket_protocol
            else "missing"
        )
        audit_event("auth.failure", request=request, outcome="denied", auth_source=auth_source)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Ungültiges oder fehlendes Auth-Token.",
        )

"""WebSocket hub for broadcasting job progress to the frontend."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket

WS_SUBPROTOCOL = "tarscribe"
WS_AUTH_SUBPROTOCOL_PREFIX = "tarscribe-auth-"


def split_subprotocols(header: str | None) -> list[str]:
    if not header:
        return []
    return [protocol.strip() for protocol in header.split(",") if protocol.strip()]


def auth_token_from_subprotocols(header: str | None) -> str:
    for protocol in split_subprotocols(header):
        if protocol.startswith(WS_AUTH_SUBPROTOCOL_PREFIX):
            return protocol.removeprefix(WS_AUTH_SUBPROTOCOL_PREFIX)
    return ""


class WsHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket, subprotocol: str | None = None) -> None:
        await ws.accept(subprotocol=subprotocol)
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def _send_all(self, message: dict[str, Any]) -> None:
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

    def broadcast(self, message: dict[str, Any]) -> None:
        """Thread-safe: callable from worker threads."""
        if self._loop is None or self._loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._send_all(message), self._loop)
        except RuntimeError:
            return


hub = WsHub()

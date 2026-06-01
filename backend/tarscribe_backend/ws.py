"""WebSocket hub for broadcasting job progress to the frontend."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class WsHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
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
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._send_all(message), self._loop)


hub = WsHub()

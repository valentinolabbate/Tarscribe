"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, jobs as job_runner, live_audio as legacy_live_audio
from .audit import audit_event, configure_audit_logger
from .config import get_settings
from .db import init_db
from .routers import (
    chats,
    dictations,
    diarization,
    documents,
    editing,
    export,
    insights,
    jobs,
    live_recordings,
    llm,
    mcp,
    rag,
    recordings,
    settings,
    speakers,
    system,
    templates,
    topics,
    transcription,
)
from .security import require_token
from .ws import WS_SUBPROTOCOL, auth_token_from_subprotocols, hub, split_subprotocols

logger = logging.getLogger("tarscribe")

_DEFAULT_ALLOWED_ORIGINS = [
    "tauri://localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://localhost:1420",
]

_ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "X-Tarscribe-Token",
    "X-Sequence-Number",
    "X-Sample-Rate",
    "X-Channels",
]

_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

_UPLOAD_PATHS = {
    "/api/dictations",
    "/api/documents",
    "/api/recordings",
    "/api/recordings/import-local",
    "/api/recordings/import-local-mixed",
}

_PROTECTED_ROUTERS = [
    system.router,
    topics.router,
    recordings.router,
    chats.router,
    documents.router,
    dictations.router,
    live_recordings.router,
    legacy_live_audio.router,
    insights.router,
    jobs.router,
    transcription.router,
    diarization.router,
    editing.router,
    export.router,
    speakers.router,
    templates.router,
    llm.router,
    mcp.router,
    rag.router,
    settings.router,
]


def _audit_http_action(method: str, path: str) -> str | None:
    if method == "DELETE" and path.startswith("/api/"):
        return "api.delete"
    if method == "POST" and path in _UPLOAD_PATHS:
        return "api.upload"
    if method == "GET" and (
        path.endswith("/audio") or path.endswith("/file") or path.endswith("/export")
    ):
        return "api.download"
    if method == "POST" and path.endswith("/send-to-folder"):
        return "api.export"
    return None


def _allowed_origins() -> list[str]:
    env = os.environ.get("TARSCRIBE_ALLOWED_ORIGINS")
    if env:
        origins = [o.strip() for o in env.split(",") if o.strip()]
        if origins:
            return origins
        logger.warning("TARSCRIBE_ALLOWED_ORIGINS set but empty — falling back to defaults")
    return _DEFAULT_ALLOWED_ORIGINS


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Let the WebSocket hub broadcast from worker threads into this loop.
    loop = asyncio.get_running_loop()
    hub.bind_loop(loop)
    job_runner.bind_loop(loop)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Tarscribe Backend", version=__version__, lifespan=lifespan)
    configure_audit_logger()

    origins = _allowed_origins()
    logger.info("CORS allowed origins: %s", origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=_ALLOWED_METHODS,
        allow_headers=_ALLOWED_HEADERS,
    )

    @app.middleware("http")
    async def _audit_sensitive_actions(request: Request, call_next):
        response = await call_next(request)
        action = _audit_http_action(request.method, request.url.path)
        if action and 200 <= response.status_code < 400:
            audit_event(
                action,
                request=request,
                status_code=response.status_code,
            )
        return response

    @app.get("/api/health", tags=["system"])
    def _health() -> dict:
        return {"status": "ok"}

    for router in _PROTECTED_ROUTERS:
        app.include_router(router, dependencies=[Depends(require_token)])

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        # Same shared secret as the REST API; browsers can open localhost
        # WebSockets cross-origin, so the handshake must be authenticated too.
        expected = get_settings().auth_token
        subprotocol_header = websocket.headers.get("sec-websocket-protocol")
        if expected and auth_token_from_subprotocols(subprotocol_header) != expected:
            audit_event(
                "auth.websocket_failure",
                outcome="denied",
                method="WEBSOCKET",
                path="/ws",
                client=websocket.client.host if websocket.client else None,
            )
            await websocket.close(code=1008)
            return
        selected_subprotocol = (
            WS_SUBPROTOCOL if WS_SUBPROTOCOL in split_subprotocols(subprotocol_header) else None
        )
        await hub.connect(websocket, subprotocol=selected_subprotocol)
        try:
            while True:
                # We only push; keep the socket alive by reading pings.
                await websocket.receive_text()
        except WebSocketDisconnect:
            hub.disconnect(websocket)

    return app


app = create_app()

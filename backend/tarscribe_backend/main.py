"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .db import init_db
from .routers import (
    dictations,
    diarization,
    documents,
    editing,
    export,
    insights,
    live_recordings,
    llm,
    rag,
    recordings,
    settings,
    speakers,
    system,
    templates,
    topics,
    transcription,
)
from .ws import hub


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Let the WebSocket hub broadcast from worker threads into this loop.
    hub.bind_loop(asyncio.get_running_loop())
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Tarscribe Backend", version=__version__, lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(system.router)
    app.include_router(topics.router)
    app.include_router(recordings.router)
    app.include_router(documents.router)
    app.include_router(dictations.router)
    app.include_router(live_recordings.router)
    app.include_router(insights.router)
    app.include_router(transcription.router)
    app.include_router(diarization.router)
    app.include_router(editing.router)
    app.include_router(export.router)
    app.include_router(speakers.router)
    app.include_router(templates.router)
    app.include_router(llm.router)
    app.include_router(rag.router)
    app.include_router(settings.router)

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        # Same shared secret as the REST API; browsers can open localhost
        # WebSockets cross-origin, so the handshake must be authenticated too.
        expected = get_settings().auth_token
        if expected and websocket.query_params.get("token", "") != expected:
            await websocket.close(code=1008)
            return
        await hub.connect(websocket)
        try:
            while True:
                # We only push; keep the socket alive by reading pings.
                await websocket.receive_text()
        except WebSocketDisconnect:
            hub.disconnect(websocket)

    return app


app = create_app()

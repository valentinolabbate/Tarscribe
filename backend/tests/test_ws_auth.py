"""WebSocket handshake auth: /ws must enforce the shared secret."""

from __future__ import annotations

import importlib
import tempfile

import pytest
from starlette.websockets import WebSocketDisconnect

TOKEN = "test-secret-token"
AUTH_PROTOCOL = f"tarscribe-auth-{TOKEN}"
WRONG_AUTH_PROTOCOL = "tarscribe-auth-wrong"
APP_PROTOCOL = "tarscribe"


def _make_client(monkeypatch, auth_token: str):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", auth_token)

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app())


def test_ws_rejects_missing_token(monkeypatch):
    client = _make_client(monkeypatch, TOKEN)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass


def test_ws_rejects_wrong_token(monkeypatch):
    client = _make_client(monkeypatch, TOKEN)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", subprotocols=[APP_PROTOCOL, WRONG_AUTH_PROTOCOL]):
            pass


def test_ws_rejects_query_token(monkeypatch):
    client = _make_client(monkeypatch, TOKEN)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws?token={TOKEN}"):
            pass


def test_ws_accepts_valid_token(monkeypatch):
    client = _make_client(monkeypatch, TOKEN)
    with client.websocket_connect("/ws", subprotocols=[APP_PROTOCOL, AUTH_PROTOCOL]) as ws:
        ws.send_text("ping")
        assert ws.accepted_subprotocol == APP_PROTOCOL


def test_ws_open_when_auth_disabled(monkeypatch):
    client = _make_client(monkeypatch, "")
    with client.websocket_connect("/ws") as ws:
        ws.send_text("ping")

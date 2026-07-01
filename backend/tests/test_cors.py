"""CORS regression tests: only Tauri/Vite origins may access the backend."""

from __future__ import annotations

import importlib
import tempfile

import pytest


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

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


def test_preflight_allowed_origin(client):
    """Preflight from a Tauri origin must return CORS headers."""
    r = client.options(
        "/api/health",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-Tarscribe-Token",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "GET" in r.headers["access-control-allow-methods"]
    assert "X-Tarscribe-Token" in r.headers["access-control-allow-headers"]


def test_preflight_vite_dev_origin(client):
    """Vite dev-server origin must be allowed."""
    r = client.options(
        "/api/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_preflight_disallowed_origin_rejected(client):
    """Preflight from an arbitrary website must NOT get CORS headers."""
    r = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    # Starlette returns 400 when the origin is not allowed.
    assert r.status_code == 400
    assert "access-control-allow-origin" not in r.headers


def test_actual_request_from_disallowed_origin_no_cors_header(client):
    """A normal GET from a foreign origin must not carry the CORS allow-origin header."""
    r = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 200  # the request itself succeeds (CORS is browser-enforced)
    assert "access-control-allow-origin" not in r.headers


def test_actual_request_from_allowed_origin_has_cors_header(client):
    r = client.get("/api/health", headers={"Origin": "tauri://localhost"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "tauri://localhost"


def test_live_audio_headers_in_allowed_headers(client):
    """Custom headers used by live PCM upload must be in the preflight response."""
    r = client.options(
        "/api/health",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-Sequence-Number, X-Sample-Rate, X-Channels",
        },
    )
    assert r.status_code == 200
    allowed = r.headers["access-control-allow-headers"]
    for h in ("X-Sequence-Number", "X-Sample-Rate", "X-Channels"):
        assert h in allowed


def test_env_var_override(monkeypatch):
    """TARSCRIBE_ALLOWED_ORIGINS must replace the default list."""
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")
    monkeypatch.setenv("TARSCRIBE_ALLOWED_ORIGINS", "http://custom.local:3000")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    client = TestClient(main.create_app())

    r = client.options(
        "/api/health",
        headers={
            "Origin": "http://custom.local:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://custom.local:3000"

    # Default origins are no longer allowed.
    r = client.options(
        "/api/health",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 400

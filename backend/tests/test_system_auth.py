"""System endpoints must enforce the shared-secret token (except /api/health)."""

from __future__ import annotations

import importlib
import tempfile

import pytest

TOKEN = "test-secret-token"


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)

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


PROTECTED_GET = [
    "/api/system/hardware",
    "/api/system/setup-status",
    "/api/system/models",
]

PROTECTED_POST = [
    "/api/system/complete-setup",
    "/api/system/warmup",
]


@pytest.mark.parametrize("path", PROTECTED_GET)
def test_get_without_token_returns_401(client, path):
    r = client.get(path)
    assert r.status_code == 401


@pytest.mark.parametrize("path", PROTECTED_POST)
def test_post_without_token_returns_401(client, path):
    r = client.post(path)
    assert r.status_code == 401


@pytest.mark.parametrize("path", PROTECTED_GET)
def test_get_with_wrong_token_returns_401(client, path):
    r = client.get(path, headers={"X-Tarscribe-Token": "wrong"})
    assert r.status_code == 401


def test_complete_setup_with_token_succeeds(client):
    r = client.post("/api/system/complete-setup", headers={"X-Tarscribe-Token": TOKEN})
    assert r.status_code == 200
    assert r.json()["setup_complete"] is True


def test_hardware_with_token_succeeds(client):
    r = client.get("/api/system/hardware", headers={"X-Tarscribe-Token": TOKEN})
    assert r.status_code == 200
    assert "recommended_asr" in r.json()


def test_setup_status_with_token_succeeds(client):
    r = client.get("/api/system/setup-status", headers={"X-Tarscribe-Token": TOKEN})
    assert r.status_code == 200
    assert "setup_complete" in r.json()


def test_models_with_token_succeeds(client):
    r = client.get("/api/system/models", headers={"X-Tarscribe-Token": TOKEN})
    assert r.status_code == 200
    assert "models_dir" in r.json()


def test_warmup_with_token_succeeds(client, monkeypatch):
    import tarscribe_backend.ml.asr.factory as factory

    class FakeBackend:
        name = "fake"

        def _ensure_model(self):
            pass

    monkeypatch.setattr(factory, "get_backend", lambda: FakeBackend())

    r = client.post("/api/system/warmup", headers={"X-Tarscribe-Token": TOKEN})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_health_endpoint_is_unprotected(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" not in body


def test_health_endpoint_has_no_version(client):
    r = client.get("/api/health")
    assert "version" not in r.json()


def test_old_system_health_endpoint_removed(client):
    r = client.get("/api/system/health")
    assert r.status_code == 404

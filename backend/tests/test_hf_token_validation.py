"""Hugging Face token validation must gate secret storage."""

from __future__ import annotations

import importlib
import tempfile
from pathlib import Path

import pytest

TOKEN = "test-secret-token"


class FakeKeyring:
    def __init__(self) -> None:
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, key: str) -> str | None:
        return self.store.get((service, key))

    def set_password(self, service: str, key: str, value: str) -> None:
        self.store[(service, key)] = value

    def delete_password(self, service: str, key: str) -> None:
        self.store.pop((service, key), None)


class FakeHfResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self.payload = payload or {}

    def json(self) -> dict:
        return self.payload


@pytest.fixture()
def app_client(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="tarscribe-test-"))
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.settings_store as settings_store

    importlib.reload(settings_store)
    fake_keyring = FakeKeyring()
    monkeypatch.setattr(settings_store, "_keyring", lambda: fake_keyring)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main
    import tarscribe_backend.routers.settings as settings_router

    importlib.reload(main)
    return TestClient(main.create_app()), fake_keyring, settings_router


def _headers() -> dict[str, str]:
    return {"X-Tarscribe-Token": TOKEN}


def test_invalid_hf_token_is_rejected_without_storing(app_client, monkeypatch):
    client, fake_keyring, settings_router = app_client
    monkeypatch.setattr(
        settings_router.httpx,
        "get",
        lambda *args, **kwargs: FakeHfResponse(401),
    )

    response = client.put(
        "/api/settings/hf-token",
        headers=_headers(),
        json={"token": "hf_invalid"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == {"saved": False, "valid": False, "error": "HTTP 401"}
    assert fake_keyring.get_password("Tarscribe", "hf_token") is None
    assert client.get("/api/settings", headers=_headers()).json()["hf_token_set"] is False


def test_valid_hf_token_is_stored(app_client, monkeypatch):
    client, fake_keyring, settings_router = app_client
    auth_headers: list[str | None] = []

    def fake_get(*args, **kwargs):
        auth_headers.append((kwargs.get("headers") or {}).get("Authorization"))
        return FakeHfResponse(200, {"name": "valid-user"})

    monkeypatch.setattr(settings_router.httpx, "get", fake_get)

    response = client.put(
        "/api/settings/hf-token",
        headers=_headers(),
        json={"token": "hf_valid"},
    )

    assert response.status_code == 200
    assert response.json() == {"saved": True, "valid": True, "name": "valid-user"}
    assert auth_headers == ["Bearer hf_valid"]
    assert fake_keyring.get_password("Tarscribe", "hf_token") == "hf_valid"

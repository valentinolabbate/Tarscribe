"""Settings secret handling must not leak or persist plaintext fallback secrets."""

from __future__ import annotations

import importlib
import json
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


@pytest.fixture()
def app_client(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="tarscribe-test-"))
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)
    monkeypatch.delenv("TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK", raising=False)

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

    importlib.reload(main)
    return TestClient(main.create_app()), settings_store, fake_keyring, tmp


def _headers() -> dict[str, str]:
    return {"X-Tarscribe-Token": TOKEN}


def _assert_no_secret(payload: object, *secrets: str) -> None:
    text = json.dumps(payload)
    for secret in secrets:
        assert secret not in text


def test_settings_and_config_responses_do_not_contain_secret_values(app_client):
    client, settings_store, _fake_keyring, _tmp = app_client
    settings_store.set_hf_token("hf_secret_value")
    settings_store.set_caldav_password("caldav-secret-value")
    settings_store.set_llm_api_key("llm-secret-value")
    settings_store.set_rag_api_key("rag-secret-value")

    settings_response = client.get("/api/settings", headers=_headers())
    llm_response = client.get("/api/llm/config", headers=_headers())
    rag_response = client.get("/api/rag/config", headers=_headers())

    assert settings_response.status_code == 200
    assert settings_response.json()["hf_token_set"] is True
    assert settings_response.json()["caldav_password_set"] is True
    assert settings_response.json()["secret_storage"]["secure"] is True
    assert llm_response.json()["api_key_set"] is True
    assert rag_response.json()["api_key_set"] is True
    _assert_no_secret(
        [settings_response.json(), llm_response.json(), rag_response.json()],
        "hf_secret_value",
        "caldav-secret-value",
        "llm-secret-value",
        "rag-secret-value",
    )


def test_caldav_password_endpoint_stores_keyring_secret_without_echoing_it(app_client):
    client, _settings_store, fake_keyring, _tmp = app_client
    response = client.put(
        "/api/settings/caldav-password",
        headers=_headers(),
        json={"password": "caldav-secret-value"},
    )

    assert response.status_code == 200
    assert response.json() == {"saved": True, "caldav_password_set": True}
    assert fake_keyring.get_password("Tarscribe", "caldav_password") == "caldav-secret-value"
    _assert_no_secret(response.json(), "caldav-secret-value")


def test_plaintext_secret_fallback_disabled_by_default(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="tarscribe-test-"))
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp))
    monkeypatch.delenv("TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK", raising=False)

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.settings_store as settings_store

    importlib.reload(settings_store)
    monkeypatch.setattr(settings_store, "_keyring", lambda: None)

    with pytest.raises(settings_store.SecretStorageUnavailable):
        settings_store.set_caldav_password("caldav-secret-value")

    assert not (tmp / ".secrets.json").exists()
    assert settings_store.secret_storage_status() == {
        "available": False,
        "secure": False,
        "keyring_available": False,
        "fallback_enabled": False,
    }


def test_secret_write_endpoint_returns_503_without_secure_store(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="tarscribe-test-"))
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)
    monkeypatch.delenv("TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK", raising=False)

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    import tarscribe_backend.settings_store as settings_store

    importlib.reload(settings_store)
    monkeypatch.setattr(settings_store, "_keyring", lambda: None)

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    client = TestClient(main.create_app())

    response = client.put(
        "/api/settings/caldav-password",
        headers=_headers(),
        json={"password": "caldav-secret-value"},
    )

    assert response.status_code == 503
    _assert_no_secret(response.json(), "caldav-secret-value")
    assert not (tmp / ".secrets.json").exists()

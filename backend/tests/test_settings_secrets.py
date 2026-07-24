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


OPENROUTER_URL = "https://openrouter.ai/api/v1"
LMSTUDIO_URL = "http://localhost:1234/v1"


def _set_global_lmstudio(client) -> None:
    response = client.put(
        "/api/llm/config",
        headers=_headers(),
        json={"provider": "lmstudio", "base_url": LMSTUDIO_URL, "model": "local-chat-model"},
    )
    assert response.status_code == 200


def test_scoped_llm_api_key_is_used_for_profile_connection(app_client):
    client, settings_store, fake_keyring, _tmp = app_client
    _set_global_lmstudio(client)

    response = client.put(
        "/api/llm/config",
        headers=_headers(),
        json={
            "profiles": {
                "chat": {"model": "local-chat-model"},
                "summaries": {
                    "provider": "openrouter",
                    "base_url": OPENROUTER_URL,
                    "model": "z-ai/glm-4.6",
                },
            }
        },
    )
    assert response.status_code == 200

    key_response = client.put(
        "/api/llm/api-key",
        headers=_headers(),
        json={"api_key": "sk-or-openrouter-key", "base_url": OPENROUTER_URL},
    )
    assert key_response.status_code == 200
    assert fake_keyring.get_password(
        "Tarscribe", f"llm_api_key@{OPENROUTER_URL}"
    ) == "sk-or-openrouter-key"
    assert fake_keyring.get_password("Tarscribe", "llm_api_key") is None

    import tarscribe_backend.llm as L

    summaries_cfg = L.get_llm_config("summaries")
    assert summaries_cfg["base_url"] == OPENROUTER_URL
    assert summaries_cfg["provider"] == "openrouter"
    assert summaries_cfg["api_key"] == "sk-or-openrouter-key"

    chat_cfg = L.get_llm_config("chat")
    assert chat_cfg["base_url"] == LMSTUDIO_URL
    assert chat_cfg["api_key"] is None

    config = client.get("/api/llm/config", headers=_headers()).json()
    assert config["api_key_set"] is False
    assert config["profiles"]["summaries"]["api_key_set"] is True
    assert config["profiles"]["chat"]["api_key_set"] is False
    _assert_no_secret(config, "sk-or-openrouter-key")


def test_llm_api_key_for_global_base_url_stays_in_legacy_slot(app_client):
    client, settings_store, fake_keyring, _tmp = app_client
    _set_global_lmstudio(client)

    response = client.put(
        "/api/llm/api-key",
        headers=_headers(),
        json={"api_key": "sk-global-key", "base_url": LMSTUDIO_URL},
    )
    assert response.status_code == 200
    assert fake_keyring.get_password("Tarscribe", "llm_api_key") == "sk-global-key"
    assert settings_store.get_llm_api_key(LMSTUDIO_URL) == "sk-global-key"
    assert settings_store.get_llm_api_key(OPENROUTER_URL) is None


def test_profile_connection_inherits_global_key_and_delete_is_scoped(app_client):
    client, settings_store, fake_keyring, _tmp = app_client
    _set_global_lmstudio(client)
    settings_store.set_llm_api_key("sk-global-key")
    settings_store.set_llm_api_key("sk-or-openrouter-key", OPENROUTER_URL)

    delete_response = client.delete(
        f"/api/llm/api-key?base_url={OPENROUTER_URL}", headers=_headers()
    )
    assert delete_response.status_code == 200
    assert settings_store.get_llm_api_key(OPENROUTER_URL) is None
    assert settings_store.get_llm_api_key() == "sk-global-key"

    import tarscribe_backend.llm as L

    assert L.get_llm_config("chat")["api_key"] == "sk-global-key"


def test_model_listing_uses_key_from_selected_connection(app_client, monkeypatch):
    client, settings_store, _fake_keyring, _tmp = app_client
    response = client.put(
        "/api/llm/config",
        headers=_headers(),
        json={
            "connections": [
                {
                    "id": "local",
                    "name": "LM Studio",
                    "provider": "lmstudio",
                    "base_url": LMSTUDIO_URL,
                },
                {
                    "id": "openrouter",
                    "name": "OpenRouter",
                    "provider": "openrouter",
                    "base_url": OPENROUTER_URL,
                },
            ],
            "profiles": {
                "chat": {"connection_id": "openrouter", "model": "z-ai/glm-4.6"}
            },
        },
    )
    assert response.status_code == 200
    settings_store.set_llm_api_key("sk-or-openrouter-key", OPENROUTER_URL)

    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"id": "z-ai/glm-4.6"}]}

    def fake_get(url, headers, timeout):
        captured.update(url=url, headers=headers, timeout=timeout)
        return FakeResponse()

    import tarscribe_backend.llm as L

    monkeypatch.setattr(L.httpx, "get", fake_get)
    models = client.get(
        "/api/llm/models?connection_id=openrouter", headers=_headers()
    )

    assert models.status_code == 200
    assert models.json() == {"models": ["z-ai/glm-4.6"]}
    assert captured["url"] == f"{OPENROUTER_URL}/models"
    assert captured["headers"] == {"Authorization": "Bearer sk-or-openrouter-key"}


def test_profile_base_url_must_be_http(app_client):
    client, _settings_store, _fake_keyring, _tmp = app_client
    response = client.put(
        "/api/llm/config",
        headers=_headers(),
        json={"profiles": {"summaries": {"base_url": "openrouter.ai/api/v1"}}},
    )
    assert response.status_code == 422

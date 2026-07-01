"""Security audit log coverage."""

from __future__ import annotations

import importlib
import json
import tempfile
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

TOKEN = "test-secret-token"


@pytest.fixture()
def app_client(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="tarscribe-audit-test-"))
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp))
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)
    monkeypatch.delenv("TARSCRIBE_AUDIT_LOG_PATH", raising=False)
    monkeypatch.delenv("TARSCRIBE_AUDIT_LOG_MAX_BYTES", raising=False)
    monkeypatch.delenv("TARSCRIBE_AUDIT_LOG_BACKUP_COUNT", raising=False)

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()

    from fastapi.testclient import TestClient

    import tarscribe_backend.main as main

    importlib.reload(main)
    return TestClient(main.create_app()), tmp


def _events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_auth_failures_are_logged_without_token_values(app_client):
    client, tmp = app_client
    wrong_token = "wrong-token-must-not-appear"

    missing = client.get("/api/system/hardware")
    wrong = client.get(
        "/api/system/hardware",
        headers={"X-Tarscribe-Token": wrong_token},
    )
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass

    assert missing.status_code == 401
    assert wrong.status_code == 401
    path = tmp / "logs" / "audit.log"
    events = _events(path)
    assert [event["action"] for event in events] == [
        "auth.failure",
        "auth.failure",
        "auth.websocket_failure",
    ]
    assert events[0]["auth_source"] == "missing"
    assert events[1]["auth_source"] == "header"
    assert events[0]["path"] == "/api/system/hardware"
    assert wrong_token not in path.read_text()
    assert TOKEN not in path.read_text()


def test_sensitive_api_and_mcp_actions_are_audited(app_client):
    client, tmp = app_client
    headers = {"X-Tarscribe-Token": TOKEN}

    topic = client.post("/api/topics", json={"name": "Audit"}, headers=headers).json()
    uploaded = client.post(
        "/api/documents",
        data={"topic_id": topic["id"]},
        files={"file": ("audit.txt", b"Audit-Inhalt", "text/plain")},
        headers=headers,
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]
    assert client.get(f"/api/documents/{document_id}/file", headers=headers).status_code == 200
    assert client.delete(f"/api/documents/{document_id}", headers=headers).status_code == 204
    assert (
        client.post(
            "/api/mcp/audit",
            json={"action": "register", "target_id": "codex"},
            headers=headers,
        ).status_code
        == 204
    )

    path = tmp / "logs" / "audit.log"
    events = _events(path)
    assert [event["action"] for event in events] == [
        "api.upload",
        "api.download",
        "api.delete",
        "mcp.register",
    ]
    assert events[-1]["target_id"] == "codex"
    assert TOKEN not in path.read_text()


def test_audit_path_and_rotation_are_configurable(monkeypatch, tmp_path):
    path = tmp_path / "custom" / "security-audit.jsonl"
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TARSCRIBE_AUDIT_LOG_PATH", str(path))
    monkeypatch.setenv("TARSCRIBE_AUDIT_LOG_MAX_BYTES", "240")
    monkeypatch.setenv("TARSCRIBE_AUDIT_LOG_BACKUP_COUNT", "2")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    from tarscribe_backend.audit import audit_event

    for index in range(20):
        audit_event(
            "rotation.test",
            sequence=index,
            detail="x" * 80,
            auth_token="must-not-appear",
        )

    assert path.exists()
    assert Path(f"{path}.1").exists()
    combined = path.read_text() + Path(f"{path}.1").read_text()
    assert "must-not-appear" not in combined
    assert "[redacted]" in combined

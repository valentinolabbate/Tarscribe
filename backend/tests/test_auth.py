"""Security regression coverage for Sprint 1 auth and CSP fixes."""

from __future__ import annotations

import importlib
import json
import re
import tempfile
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

TOKEN = "test-secret-token"
API_METHODS = {"DELETE", "GET", "PATCH", "POST", "PUT"}
PUBLIC_API_PATHS = {"/api/health"}
PATH_VALUES = {
    "chat_id": "1",
    "digest_id": "1",
    "document_id": "1",
    "item_id": "1",
    "job_id": "1",
    "label": "SPEAKER_00",
    "recording_id": "1",
    "session_id": "00000000-0000-0000-0000-000000000001",
    "speaker_id": "1",
    "summary_id": "1",
    "target_id": "claude_desktop",
    "template_id": "1",
    "topic_id": "1",
}


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", TOKEN)
    monkeypatch.delenv("TARSCRIBE_ALLOWED_ORIGINS", raising=False)

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


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _path_for_route(route_path: str) -> str:
    return re.sub(r"{([^}:]+)(?::[^}]+)?}", lambda m: PATH_VALUES.get(m.group(1), "1"), route_path)


def _api_route_cases(app):
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.path.startswith("/api/") or route.path in PUBLIC_API_PATHS:
            continue
        for method in sorted(route.methods & API_METHODS):
            yield method, _path_for_route(route.path)


@pytest.mark.parametrize("headers", [{}, {"X-Tarscribe-Token": "wrong"}])
def test_all_api_routes_reject_missing_or_wrong_token(client, headers):
    failures = []
    for method, path in _api_route_cases(client.app):
        response = client.request(method, path, headers=headers)
        if response.status_code != 401:
            failures.append(f"{method} {path} -> {response.status_code}")
    assert failures == []


def test_all_protected_api_routes_use_global_auth_dependency(client):
    from tarscribe_backend.security import require_token

    failures = []
    for route in client.app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.path.startswith("/api/") or route.path in PUBLIC_API_PATHS:
            continue
        dependency_calls = {dep.call for dep in route.dependant.dependencies}
        if require_token not in dependency_calls:
            failures.append(route.path)
    assert failures == []


def test_router_modules_do_not_attach_auth_dependencies_locally():
    router_dir = _repo_root() / "backend/tarscribe_backend/routers"
    offenders = []
    for path in router_dir.glob("*.py"):
        if path.name == "__init__.py":
            continue
        if "require_token" in path.read_text():
            offenders.append(path.name)
    assert offenders == []


def test_auth_accepts_cookie_token(client):
    client.cookies.set("tarscribe_token", TOKEN)
    try:
        response = client.get("/api/system/hardware")
        assert response.status_code == 200
    finally:
        client.cookies.clear()


def test_auth_accepts_subprotocol_header_token(client):
    response = client.get(
        "/api/system/hardware",
        headers={"Sec-WebSocket-Protocol": f"tarscribe, tarscribe-auth-{TOKEN}"},
    )
    assert response.status_code == 200


def test_health_is_the_only_public_api_route(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_tauri_csp_keeps_sprint_one_security_baseline():
    config = json.loads((_repo_root() / "desktop/src-tauri/tauri.conf.json").read_text())
    csp = config["app"]["security"]["csp"]
    assert csp is not None
    assert "default-src 'self'" in csp
    assert "script-src 'self'" in csp
    assert "'unsafe-eval'" not in csp
    assert "object-src 'none'" in csp
    assert "base-uri 'self'" in csp
    assert "form-action 'self'" in csp
    assert "worker-src 'self'" in csp
    assert "worker-src 'self' blob:" not in csp


def test_frontend_websocket_auth_does_not_use_query_token():
    source = (_repo_root() / "desktop/src/lib/api.ts").read_text()
    assert "?token=" not in source
    assert "tarscribe-auth-" in source
    assert "new WebSocket(url, protocols)" in source


def test_tauri_frontend_uses_proxy_instead_of_backend_token():
    api_source = (_repo_root() / "desktop/src/lib/api.ts").read_text()
    sidecar_source = (_repo_root() / "desktop/src-tauri/src/sidecar.rs").read_text()

    public_config = sidecar_source.split("pub struct PublicBackendConfig", 1)[1].split("}", 1)[0]
    assert "token" not in public_config
    assert 'tauriInvoke<ProxyResponse>("proxy_request"' in api_source
    assert 'tauriInvoke<string>("backend_ws_connect"' in api_source
    assert 'tauriInvoke<ArrayBuffer | number[]>("proxy_binary"' in api_source
    assert "Result<tauri::ipc::Response, String>" in sidecar_source

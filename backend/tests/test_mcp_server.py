"""Tests for the bundled MCP server: discovery, client, orchestrator, registration."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from tarscribe_backend import mcp_link
from tarscribe_backend.mcp_server import client as C


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in ("TARSCRIBE_BASE_URL", "TARSCRIBE_AUTH_TOKEN", "TARSCRIBE_MCP_CONNECTION_FILE"):
        monkeypatch.delenv(var, raising=False)


# ── discovery ────────────────────────────────────────────────────────────────
def test_discover_reads_connection_file(tmp_path, monkeypatch):
    f = tmp_path / "conn.json"
    f.write_text(json.dumps({"base_url": "http://127.0.0.1:9000/", "token": "abc"}))
    monkeypatch.setenv("TARSCRIBE_MCP_CONNECTION_FILE", str(f))

    conn = C.discover()
    assert conn.base_url == "http://127.0.0.1:9000"  # trailing slash stripped
    assert conn.token == "abc"


def test_discover_env_override_wins(monkeypatch):
    monkeypatch.setenv("TARSCRIBE_BASE_URL", "http://localhost:1234/")
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "tok")
    conn = C.discover()
    assert conn.base_url == "http://localhost:1234"
    assert conn.token == "tok"


def test_discover_missing_file_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("TARSCRIBE_MCP_CONNECTION_FILE", str(tmp_path / "nope.json"))
    with pytest.raises(C.BackendUnavailable):
        C.discover()


# ── client (mocked backend) ──────────────────────────────────────────────────
def _client(handler) -> C.BackendClient:
    transport = httpx.MockTransport(handler)
    return C.BackendClient(C.Connection("http://test", "tok"), transport=transport)


def test_client_sends_token_and_parses_json():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["token"] = request.headers.get("X-Tarscribe-Token")
        return httpx.Response(200, json=[{"id": 1, "name": "Topic"}])

    with _client(handler) as c:
        topics = c.list_topics()
    assert seen["token"] == "tok"
    assert topics[0]["name"] == "Topic"


def test_client_401_is_backend_unavailable():
    with _client(lambda r: httpx.Response(401, json={"detail": "nope"})) as c:
        with pytest.raises(C.BackendUnavailable):
            c.list_topics()


def test_client_4xx_is_runtime_error():
    with _client(lambda r: httpx.Response(404, text="missing")) as c:
        with pytest.raises(RuntimeError):
            c.get_transcript(99)


def test_upload_recording_posts_multipart(tmp_path):
    audio = tmp_path / "rec.wav"
    audio.write_bytes(b"RIFFxxxx")
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["ctype"] = request.headers.get("content-type", "")
        captured["body"] = request.content
        return httpx.Response(201, json={"id": 7, "title": "rec"})

    with _client(handler) as c:
        rec = c.upload_recording(str(audio), topic_id=3, title="rec")
    assert rec["id"] == 7
    assert captured["ctype"].startswith("multipart/form-data")
    assert b'name="topic_id"' in captured["body"]


def test_upload_recording_missing_file():
    with _client(lambda r: httpx.Response(201, json={})) as c:
        with pytest.raises(RuntimeError, match="nicht gefunden"):
            c.upload_recording("/no/such/file.wav", topic_id=1)


# ── job polling ──────────────────────────────────────────────────────────────
def test_wait_for_job_polls_until_done():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        status = "done" if calls["n"] >= 2 else "running"
        return httpx.Response(200, json=[{"job_id": 5, "phase": "asr", "status": status}])

    with _client(handler) as c:
        job = c.wait_for_job(1, 5, timeout=10, poll=0, sleep=lambda _: None)
    assert job["status"] == "done"
    assert calls["n"] == 2


def test_wait_for_job_failed_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"job_id": 5, "phase": "asr", "status": "failed", "error": "boom"}])

    with _client(handler) as c:
        with pytest.raises(RuntimeError, match="boom"):
            c.wait_for_job(1, 5, timeout=10, sleep=lambda _: None)


def test_wait_for_job_times_out():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"job_id": 5, "status": "running"}])

    with _client(handler) as c:
        with pytest.raises(TimeoutError):
            c.wait_for_job(1, 5, timeout=0, sleep=lambda _: None)


# ── orchestrator ─────────────────────────────────────────────────────────────
def test_process_recording_end_to_end(tmp_path):
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF0000")

    def handler(request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path == "/api/recordings" and method == "POST":
            return httpx.Response(201, json={"id": 1})
        if path == "/api/recordings/1/transcribe":
            return httpx.Response(200, json={"job_id": 10, "status": "queued"})
        if path == "/api/recordings/1/diarize":
            return httpx.Response(200, json={"job_id": 11, "status": "queued"})
        if path == "/api/recordings/1/match":
            return httpx.Response(200, json={"matches": [{"label": "S1", "name": "Anna"}]})
        if path == "/api/recordings/1/jobs":
            return httpx.Response(200, json=[
                {"job_id": 10, "phase": "asr", "status": "done"},
                {"job_id": 11, "phase": "diarization", "status": "done"},
            ])
        if path == "/api/recordings/1/transcript":
            return httpx.Response(200, json={"text": "Hallo Welt", "language": "de"})
        if path == "/api/recordings/1/diarization":
            return httpx.Response(200, json={
                "speakers": [{"label": "S1", "name": "Anna"}],
                "utterances": [{"speaker": "S1", "name": "Anna", "start": 0, "end": 1, "text": "Hallo"}],
            })
        return httpx.Response(404, text=f"unexpected {method} {path}")

    with _client(handler) as c:
        result = C.process_recording(c, str(audio), topic_id=2, sleep=lambda _: None)

    assert result["recording_id"] == 1
    assert result["transcript_text"] == "Hallo Welt"
    assert result["speakers"][0]["name"] == "Anna"
    assert result["utterances"][0]["text"] == "Hallo"
    assert result["speaker_matches"][0]["name"] == "Anna"
    assert [s["step"] for s in result["steps"]] == ["upload", "transcribe", "diarize", "match_speakers"]


def test_process_recording_skips_diarization():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/recordings" and request.method == "POST":
            return httpx.Response(201, json={"id": 1})
        if path == "/api/recordings/1/transcribe":
            return httpx.Response(200, json={"job_id": 10})
        if path == "/api/recordings/1/jobs":
            return httpx.Response(200, json=[{"job_id": 10, "status": "done"}])
        if path == "/api/recordings/1/transcript":
            return httpx.Response(200, json={"text": "x", "language": "de"})
        return httpx.Response(404, text=path)

    # no temp file needed: upload is the first call and must find the file, so create one
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        with _client(handler) as c:
            result = C.process_recording(
                c, f.name, topic_id=1, diarize=False, sleep=lambda _: None
            )
    assert "speakers" not in result
    assert [s["step"] for s in result["steps"]] == ["upload", "transcribe"]


# ── host registration ────────────────────────────────────────────────────────
def _make_target(tmp_path, fmt: str, name: str) -> mcp_link.HostTarget:
    path = tmp_path / name
    return mcp_link.HostTarget(fmt, fmt, fmt, path, tmp_path)


def test_known_hosts_present():
    ids = {t.id for t in mcp_link.host_targets()}
    assert {"claude-desktop", "claude-code", "opencode", "codex", "hermes"} <= ids


def test_launch_command_sets_pythonpath():
    cmd = mcp_link.launch_command()
    assert cmd["args"] == ["-m", "tarscribe_backend.mcp_server"]
    # PYTHONPATH points at the dir containing the tarscribe_backend package.
    assert (Path(cmd["env"]["PYTHONPATH"]) / "tarscribe_backend").is_dir()


def test_register_claude_format_preserves_other_servers(tmp_path):
    t = _make_target(tmp_path, "claude", "claude_desktop_config.json")
    t.path.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))

    assert mcp_link.is_registered(t) is False
    assert mcp_link.register(t)["registered"] is True
    data = json.loads(t.path.read_text())
    assert "other" in data["mcpServers"]
    assert data["mcpServers"]["tarscribe"]["args"] == ["-m", "tarscribe_backend.mcp_server"]
    assert mcp_link.is_registered(t) is True

    mcp_link.unregister(t)
    data = json.loads(t.path.read_text())
    assert "tarscribe" not in data["mcpServers"]
    assert "other" in data["mcpServers"]


def test_register_opencode_format(tmp_path):
    t = _make_target(tmp_path, "opencode", "opencode.json")
    mcp_link.register(t)
    data = json.loads(t.path.read_text())
    entry = data["mcp"]["tarscribe"]
    assert entry["type"] == "local"
    assert entry["command"][1:] == ["-m", "tarscribe_backend.mcp_server"]
    assert entry["enabled"] is True
    assert data["$schema"].startswith("https://opencode.ai")
    assert mcp_link.is_registered(t) is True


def test_register_hermes_yaml_format(tmp_path):
    import yaml

    t = _make_target(tmp_path, "hermes", "config.yaml")
    t.path.write_text(yaml.safe_dump({"mcp_servers": {"keep": {"command": "y"}}}))
    mcp_link.register(t)
    data = yaml.safe_load(t.path.read_text())
    assert "keep" in data["mcp_servers"]
    assert data["mcp_servers"]["tarscribe"]["args"] == ["-m", "tarscribe_backend.mcp_server"]
    assert mcp_link.is_registered(t) is True
    mcp_link.unregister(t)
    assert "tarscribe" not in yaml.safe_load(t.path.read_text())["mcp_servers"]


def test_register_codex_toml_upsert(tmp_path):
    t = _make_target(tmp_path, "codex", "config.toml")
    t.path.write_text('[mcp_servers.other]\ncommand = "z"\nargs = ["a"]\n')

    assert mcp_link.is_registered(t) is False
    mcp_link.register(t)
    text = t.path.read_text()
    assert "[mcp_servers.other]" in text  # preserved
    assert "[mcp_servers.tarscribe]" in text
    assert "env = { PYTHONPATH = " in text  # inline env table, not a subtable
    assert mcp_link.is_registered(t) is True

    # idempotent: registering again must not duplicate the block
    mcp_link.register(t)
    assert t.path.read_text().count("[mcp_servers.tarscribe]") == 1

    mcp_link.unregister(t)
    text = t.path.read_text()
    assert "[mcp_servers.tarscribe]" not in text
    assert "[mcp_servers.other]" in text


def test_register_creates_file_when_absent(tmp_path):
    t = _make_target(tmp_path / "sub", "claude", "config.json")
    mcp_link.register(t)
    assert t.path.exists()
    assert json.loads(t.path.read_text())["mcpServers"]["tarscribe"]["command"]


def test_target_status_shape():
    rows = mcp_link.target_status()
    assert all({"id", "label", "path", "present", "registered"} <= r.keys() for r in rows)


def test_registration_snippet_is_valid_json():
    snippet = json.loads(mcp_link.registration_snippet())
    assert "tarscribe" in snippet["mcpServers"]


# ── server module wiring ─────────────────────────────────────────────────────
def test_server_exposes_expected_tools():
    import asyncio

    from tarscribe_backend.mcp_server import server

    tools = {t.name for t in asyncio.run(server.mcp.list_tools())}
    assert {"process_recording_pipeline", "upload_recording", "start_transcription",
            "get_diarization", "list_topics"} <= tools

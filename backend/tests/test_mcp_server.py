"""Tests for the bundled MCP server: discovery, client, orchestrator, and status."""

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


def test_wait_for_jobs_waits_until_matching_phase_done():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        status = "done" if calls["n"] >= 2 else "running"
        return httpx.Response(
            200,
            json=[
                {"job_id": 5, "phase": "asr", "status": status},
                {"job_id": 6, "phase": "summarize", "status": "done"},
            ],
        )

    with _client(handler) as c:
        result = c.wait_for_jobs(1, phases=["asr"], timeout=10, poll=0, sleep=lambda _: None)
    assert result["status"] == "done"
    assert result["jobs"][0]["phase"] == "asr"


def test_search_action_items_and_context_helpers():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path == "/api/rag/search" and method == "POST":
            seen["search"] = json.loads(request.content)
            return httpx.Response(200, json={"hits": [{"recording_id": 1, "text": "Treffer"}]})
        if path == "/api/action-items" and method == "GET":
            seen["done"] = request.url.params.get("done")
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 2,
                        "recording_id": 1,
                        "kind": "task",
                        "text": "Plan schreiben",
                        "done": False,
                    }
                ],
            )
        if path == "/api/action-items/2" and method == "PATCH":
            seen["patch"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 2,
                    "recording_id": 1,
                    "kind": "task",
                    "text": "Plan schreiben",
                    "done": True,
                },
            )
        if path == "/api/recordings/1":
            return httpx.Response(200, json={"id": 1, "title": "Meeting"})
        if path == "/api/recordings/1/jobs":
            return httpx.Response(200, json=[])
        if path == "/api/recordings/1/transcript":
            return httpx.Response(200, json={"text": "Hallo Welt"})
        if path == "/api/recordings/1/diarization":
            return httpx.Response(200, json={"speakers": [], "utterances": []})
        if path == "/api/recordings/1/chapters":
            return httpx.Response(200, json=[])
        if path == "/api/recordings/1/summaries":
            return httpx.Response(200, json=[{"id": 3, "content": "Kurz"}])
        if path == "/api/recordings/1/action-items":
            return httpx.Response(200, json=[{"id": 2, "text": "Plan schreiben"}])
        if path == "/api/recordings/1/threads":
            return httpx.Response(200, json=[])
        return httpx.Response(404, text=f"unexpected {method} {path}")

    with _client(handler) as c:
        hits = c.semantic_search("Plan", topic_id=4, top_k=3)
        items = c.list_action_items(done=False)
        updated = c.update_action_item(2, done=True)
        context = C.get_recording_context(c, 1)

    assert hits["hits"][0]["text"] == "Treffer"
    assert seen["search"]["topic_id"] == 4
    assert seen["search"]["top_k"] == 3
    assert seen["done"] == "false"
    assert items[0]["text"] == "Plan schreiben"
    assert seen["patch"] == {"done": True}
    assert updated["done"] is True
    assert context["recording"]["title"] == "Meeting"
    assert context["summaries"][0]["content"] == "Kurz"


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
        if path == "/api/recordings/1/chapters/generate":
            return httpx.Response(200, json={"job_id": 12, "status": "queued"})
        if path == "/api/recordings/1/match":
            return httpx.Response(200, json={"matches": [{"label": "S1", "name": "Anna"}]})
        if path == "/api/recordings/1/jobs":
            return httpx.Response(
                200,
                json=[
                    {"job_id": 10, "phase": "asr", "status": "done"},
                    {"job_id": 11, "phase": "diarization", "status": "done"},
                    {"job_id": 12, "phase": "chapters", "status": "done"},
                ],
            )
        if path == "/api/recordings/1/transcript":
            return httpx.Response(200, json={"text": "Hallo Welt", "language": "de"})
        if path == "/api/recordings/1/chapters":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "recording_id": 1,
                        "idx": 0,
                        "start": 0.0,
                        "end": 60.0,
                        "title": "Intro",
                    },
                    {
                        "id": 2,
                        "recording_id": 1,
                        "idx": 1,
                        "start": 60.0,
                        "end": 120.0,
                        "title": "Plan",
                    },
                ],
            )
        if path == "/api/recordings/1/diarization":
            return httpx.Response(
                200,
                json={
                    "speakers": [{"label": "S1", "name": "Anna"}],
                    "utterances": [
                        {
                            "speaker": "S1",
                            "name": "Anna",
                            "start": 0,
                            "end": 1,
                            "text": "Hallo",
                        }
                    ],
                },
            )
        return httpx.Response(404, text=f"unexpected {method} {path}")

    with _client(handler) as c:
        result = C.process_recording(c, str(audio), topic_id=2, sleep=lambda _: None)

    assert result["recording_id"] == 1
    assert result["transcript_text"] == "Hallo Welt"
    assert result["chapters"][1]["title"] == "Plan"
    assert result["speakers"][0]["name"] == "Anna"
    assert result["utterances"][0]["text"] == "Hallo"
    assert result["speaker_matches"][0]["name"] == "Anna"
    assert [s["step"] for s in result["steps"]] == [
        "upload",
        "transcribe",
        "detect_chapters",
        "diarize",
        "match_speakers",
    ]


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
                c,
                f.name,
                topic_id=1,
                detect_chapters=False,
                diarize=False,
                sleep=lambda _: None,
            )
    assert "speakers" not in result
    assert "chapters" not in result
    assert [s["step"] for s in result["steps"]] == ["upload", "transcribe"]


# ── summary creation + export ────────────────────────────────────────────────
def test_create_summary_default_template_waits_and_returns_content():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/templates":
            return httpx.Response(
                200,
                json=[
                    {"id": 1, "name": "Custom", "is_builtin": False},
                    {"id": 2, "name": "Standard", "is_builtin": True},
                ],
            )
        if path == "/api/recordings/5/summarize":
            captured["template_id"] = request.url.params.get("template_id")
            return httpx.Response(200, json={"job_id": 9, "summary_id": 3})
        if path == "/api/recordings/5/jobs":
            return httpx.Response(200, json=[{"job_id": 9, "phase": "summarize", "status": "done"}])
        if path == "/api/summaries/3":
            return httpx.Response(
                200,
                json={
                    "id": 3,
                    "content": "## Ergebnis\nAlles gut.",
                    "model": "llama",
                    "sources": '[{"index": 1, "recording_id": null, "recording_title": "Vorgaben.pdf", "document_id": 4, "source_type": "document"}]',
                },
            )
        return httpx.Response(404, text=path)

    with _client(handler) as c:
        res = C.create_summary(c, 5, sleep=lambda _: None)

    # Default resolution prefers the built-in template.
    assert captured["template_id"] == "2"
    assert res["summary_id"] == 3
    assert res["status"] == "done"
    assert "Alles gut" in res["content"]
    # sources JSON is parsed into a list for the agent.
    assert res["sources"][0]["recording_title"] == "Vorgaben.pdf"


def test_create_summary_resolves_template_by_name():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/templates":
            return httpx.Response(
                200, json=[{"id": 1, "name": "Meeting"}, {"id": 2, "name": "Aufgaben"}]
            )
        if path == "/api/recordings/5/summarize":
            assert request.url.params.get("template_id") == "2"
            return httpx.Response(200, json={"job_id": 9, "summary_id": 3})
        return httpx.Response(404, text=path)

    with _client(handler) as c:
        res = C.create_summary(c, 5, template_name="aufgaben", wait=False)
    assert res["template_id"] == 2
    assert res["status"] == "running"


def test_create_summary_no_templates_raises():
    with _client(lambda r: httpx.Response(200, json=[])) as c:
        with pytest.raises(RuntimeError, match="Vorlage"):
            C.create_summary(c, 5)


def test_export_summary_writes_markdown(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/summaries/3":
            return httpx.Response(200, json={"id": 3, "content": "# Titel\nInhalt."})
        return httpx.Response(404, text=request.url.path)

    target = tmp_path / "out" / "summary.md"
    with _client(handler) as c:
        res = C.export_summary(c, 3, str(target))
    assert target.read_text(encoding="utf-8") == "# Titel\nInhalt."
    assert res["path"] == str(target)


def test_export_summary_empty_content_raises(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": 3, "content": "   "})

    with _client(handler) as c:
        with pytest.raises(RuntimeError, match="keinen Inhalt"):
            C.export_summary(c, 3, str(tmp_path / "x.md"))


# ── host status ──────────────────────────────────────────────────────────────
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


def test_is_registered_claude_format_detects_existing_server(tmp_path):
    t = _make_target(tmp_path, "claude", "claude_desktop_config.json")
    t.path.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))

    assert mcp_link.is_registered(t) is False
    t.path.write_text(
        json.dumps({"mcpServers": {"other": {"command": "x"}, "tarscribe": {"command": "y"}}})
    )
    data = json.loads(t.path.read_text())
    assert "other" in data["mcpServers"]
    assert mcp_link.is_registered(t) is True

def test_is_registered_opencode_format_detects_existing_server(tmp_path):
    t = _make_target(tmp_path, "opencode", "opencode.json")
    t.path.write_text(json.dumps({"mcp": {"tarscribe": {"type": "local"}}}))
    assert mcp_link.is_registered(t) is True


def test_is_registered_hermes_yaml_format_detects_existing_server(tmp_path):
    import yaml

    t = _make_target(tmp_path, "hermes", "config.yaml")
    t.path.write_text(yaml.safe_dump({"mcp_servers": {"tarscribe": {"command": "y"}}}))
    assert mcp_link.is_registered(t) is True


def test_is_registered_codex_toml_detects_existing_server(tmp_path):
    t = _make_target(tmp_path, "codex", "config.toml")
    t.path.write_text('[mcp_servers.other]\ncommand = "z"\nargs = ["a"]\n')

    assert mcp_link.is_registered(t) is False
    t.path.write_text('[mcp_servers.tarscribe]\ncommand = "x"\n')
    assert mcp_link.is_registered(t) is True


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
    assert {
        "analyze_recording",
        "get_recording_context",
        "process_recording_pipeline",
        "search_recordings",
        "list_action_items",
        "update_action_item",
        "wait_for_jobs",
        "upload_recording",
        "start_transcription",
        "start_chapter_detection",
        "get_chapters",
        "get_diarization",
        "list_topics",
        "list_templates",
        "create_summary",
        "export_summary",
    } <= tools

"""Endpoints to inspect the bundled MCP server for agent hosts."""

from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from .. import mcp_link as M
from ..audit import audit_event
from ..config import mcp_connection_path

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class McpAuditIn(BaseModel):
    action: Literal["register", "unregister"]
    target_id: Literal["claude-desktop", "claude-code", "opencode", "codex", "hermes"]


@router.post("/audit", status_code=204)
def record_audit(payload: McpAuditIn, request: Request) -> None:
    audit_event(
        f"mcp.{payload.action}",
        request=request,
        target_id=payload.target_id,
    )


@router.get("/info")
def info() -> dict:
    cmd = M.launch_command()
    return {
        "module": M.MCP_MODULE,
        "command": cmd["command"],
        "args": cmd["args"],
        "connection_file": str(mcp_connection_path()),
        "snippet": M.registration_snippet(),
        "targets": M.target_status(),
    }


def _connection_file_status() -> dict:
    path = mcp_connection_path()
    payload: dict = {}
    valid = False
    error: str | None = None
    try:
        payload = json.loads(path.read_text())
        valid = bool(payload.get("base_url"))
    except FileNotFoundError:
        error = "Verbindungsdatei fehlt"
    except (OSError, json.JSONDecodeError) as exc:
        error = str(exc)
    return {
        "ok": valid,
        "path": str(path),
        "exists": path.exists(),
        "base_url": payload.get("base_url"),
        "version": payload.get("version"),
        "started_at": payload.get("started_at"),
        "token_present": bool(payload.get("token")),
        "error": error,
    }


def _tool_names() -> list[str]:
    from ..mcp_server import server

    tools = asyncio.run(server.mcp.list_tools())
    return sorted(tool.name for tool in tools)


def _capabilities(tool_names: set[str]) -> list[dict]:
    rows = [
        (
            "upload",
            "Upload & Pipeline",
            ["upload_recording", "process_recording_pipeline", "start_transcription"],
        ),
        (
            "context",
            "Kontext abrufen",
            ["get_recording_context", "get_transcript", "get_diarization", "list_summaries"],
        ),
        (
            "search",
            "Suche",
            ["search_recordings"],
        ),
        (
            "tasks",
            "Aufgaben",
            ["list_action_items", "update_action_item"],
        ),
        (
            "analysis",
            "Analyse",
            ["analyze_recording", "create_summary", "wait_for_jobs"],
        ),
        (
            "export",
            "Export",
            ["export_summary"],
        ),
    ]
    return [
        {
            "id": cap_id,
            "label": label,
            "ready": all(name in tool_names for name in names),
            "tools": names,
        }
        for cap_id, label, names in rows
    ]


@router.get("/diagnostics")
def diagnostics() -> dict:
    connection = _connection_file_status()
    tool_error: str | None = None
    try:
        tools = _tool_names()
    except Exception as exc:  # noqa: BLE001
        tools = []
        tool_error = str(exc)
    tool_set = set(tools)
    capabilities = _capabilities(tool_set)
    tools_ok = bool(tools) and tool_error is None
    return {
        "ok": connection["ok"] and tools_ok,
        "connection_file": connection,
        "backend": {"ok": True, "status": "ok"},
        "tools": {"ok": tools_ok, "count": len(tools), "names": tools, "error": tool_error},
        "capabilities": capabilities,
    }

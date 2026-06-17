"""Endpoints to inspect and (de)register the bundled MCP server with agent hosts."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import mcp_link as M
from ..config import mcp_connection_path
from ..security import require_token

router = APIRouter(prefix="/api/mcp", tags=["mcp"], dependencies=[Depends(require_token)])


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


def _target(target_id: str) -> M.HostTarget:
    try:
        return M.get_target(target_id)
    except KeyError as exc:
        raise HTTPException(404, f"Unbekannter Agent-Host: {target_id}") from exc


@router.post("/register/{target_id}")
def register(target_id: str) -> dict:
    """Add the Tarscribe server to a host's config (merging, non-destructive)."""
    return M.register(_target(target_id))


@router.delete("/register/{target_id}")
def unregister(target_id: str) -> dict:
    return M.unregister(_target(target_id))

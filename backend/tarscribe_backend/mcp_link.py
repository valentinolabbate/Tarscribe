"""Publish the MCP connection descriptor and report agent-host status.

The packaged app starts the backend on a random port with a per-launch token,
both known only to the Tauri shell. To let an external (stdio) MCP server reach
the *running* instance, the backend drops a small descriptor file at a canonical
path on startup; the MCP server reads it and verifies it via ``/health``.
"""

from __future__ import annotations

import json
import os
import platform
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .config import Settings, mcp_connection_path

# The agent host launches this module with the app's runtime venv interpreter.
MCP_MODULE = "tarscribe_backend.mcp_server"
SERVER_KEY = "tarscribe"
# Directory containing the `tarscribe_backend` package this process runs from.
# In the packaged app this is the bundled source (kept in sync with the app
# version), so the MCP server imports the current code regardless of whether the
# venv's installed copy was refreshed.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])


def write_connection_file(settings: Settings) -> None:
    path = mcp_connection_path()
    payload = {
        "base_url": f"http://{settings.host}:{settings.port}",
        "token": settings.auth_token,
        "data_dir": str(settings.data_dir),
        "pid": os.getpid(),
        "version": __version__,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2))
        path.chmod(0o600)  # token is a secret
    except OSError:
        # Discovery is best-effort; never block backend startup on it.
        pass


def remove_connection_file() -> None:
    try:
        mcp_connection_path().unlink()
    except (FileNotFoundError, OSError):
        pass


# ── agent-host discovery ─────────────────────────────────────────────────────
def launch_command() -> dict:
    """The stdio launch command for an agent host. ``sys.executable`` is the
    app's runtime venv interpreter (in app data, signed, not quarantined);
    ``PYTHONPATH`` points at the bundled backend source so the current code is
    used even if the venv's installed copy lags behind."""
    return {
        "command": sys.executable,
        "args": ["-m", MCP_MODULE],
        "env": {"PYTHONPATH": _BACKEND_ROOT},
    }


_CONTAINER = {"claude": "mcpServers", "opencode": "mcp", "hermes": "mcp_servers"}
_CODEX_HEADER = f"[mcp_servers.{SERVER_KEY}]"


@dataclass(frozen=True)
class HostTarget:
    id: str
    label: str
    fmt: str          # "claude" | "opencode" | "codex" | "hermes"
    path: Path
    marker: Path      # dir whose existence suggests the host is installed


def host_targets() -> list[HostTarget]:
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        claude_desktop = home / "Library/Application Support/Claude/claude_desktop_config.json"
    elif system == "Windows":
        base = os.environ.get("APPDATA")
        claude_desktop = (Path(base) if base else home / "AppData/Roaming") / "Claude/claude_desktop_config.json"
    else:
        claude_desktop = home / ".config/Claude/claude_desktop_config.json"
    return [
        HostTarget("claude-desktop", "Claude Desktop", "claude", claude_desktop, claude_desktop.parent),
        HostTarget("claude-code", "Claude Code", "claude", home / ".claude.json", home / ".claude"),
        HostTarget("opencode", "opencode", "opencode", home / ".config/opencode/opencode.json", home / ".config/opencode"),
        HostTarget("codex", "Codex CLI", "codex", home / ".codex/config.toml", home / ".codex"),
        HostTarget("hermes", "Hermes Agent", "hermes", home / ".hermes/config.yaml", home / ".hermes"),
    ]


def get_target(target_id: str) -> HostTarget:
    for t in host_targets():
        if t.id == target_id:
            return t
    raise KeyError(target_id)


def _read_structured(target: HostTarget) -> dict:
    """Load a JSON/YAML host config to a dict (empty on missing/invalid)."""
    try:
        text = target.path.read_text()
    except (FileNotFoundError, OSError):
        return {}
    try:
        if target.fmt == "hermes":
            import yaml

            data = yaml.safe_load(text) or {}
        else:
            data = json.loads(text or "{}")
    except Exception:  # noqa: BLE001 — never crash on a user-edited config
        return {}
    return data if isinstance(data, dict) else {}


def is_registered(target: HostTarget) -> bool:
    if target.fmt == "codex":
        try:
            return any(line.strip() == _CODEX_HEADER for line in target.path.read_text().splitlines())
        except (FileNotFoundError, OSError):
            return False
    data = _read_structured(target)
    servers = data.get(_CONTAINER[target.fmt])
    return isinstance(servers, dict) and SERVER_KEY in servers


def target_status() -> list[dict]:
    out = []
    for t in host_targets():
        out.append(
            {
                "id": t.id,
                "label": t.label,
                "fmt": t.fmt,
                "path": str(t.path),
                "present": t.path.exists() or t.marker.exists(),
                "registered": is_registered(t),
            }
        )
    return out


def registration_snippet() -> str:
    """Generic JSON snippet for manual setup (hosts using the mcpServers schema)."""
    return json.dumps({"mcpServers": {SERVER_KEY: launch_command()}}, indent=2)

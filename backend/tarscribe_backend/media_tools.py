"""Discovery helpers for external media tools used by the backend."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


COMMON_TOOL_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
)


def _is_executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _search_path() -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for part in [*os.environ.get("PATH", "").split(os.pathsep), *COMMON_TOOL_DIRS]:
        if not part or part in seen:
            continue
        seen.add(part)
        parts.append(part)
    return os.pathsep.join(parts)


def media_tool_path(tool: str) -> str | None:
    """Return an executable path for a media tool such as ffmpeg or ffprobe."""
    for key in (f"TARSCRIBE_{tool.upper()}_PATH", f"TARSCRIBE_{tool.upper()}"):
        configured = os.environ.get(key)
        if configured:
            path = Path(configured).expanduser()
            if _is_executable(path):
                return str(path)

    resolved = shutil.which(tool, path=_search_path())
    if resolved:
        return resolved

    for base in COMMON_TOOL_DIRS:
        candidate = Path(base) / tool
        if _is_executable(candidate):
            return str(candidate)
    return None


def is_media_tool_available(tool: str) -> bool:
    return media_tool_path(tool) is not None

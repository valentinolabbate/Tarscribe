"""Upload suffix and storage path validation."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

AUDIO_UPLOAD_SUFFIXES = {
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
    ".webm",
    ".flac",
    ".aac",
    ".mov",
    ".mp4",
}
LOCAL_AUDIO_SUFFIXES = AUDIO_UPLOAD_SUFFIXES | {".caf"}
DOCUMENT_UPLOAD_SUFFIXES = {
    ".pdf",
    ".txt",
    ".text",
    ".md",
    ".markdown",
    ".docx",
    ".html",
    ".htm",
    ".epub",
}


class UploadValidationError(ValueError):
    pass


class UploadPathForbidden(PermissionError):
    pass


def display_filename(filename: str | None, default: str) -> str:
    name = Path(filename or default).name.strip()
    return name or default


def require_suffix(filename: str | None, allowed: set[str], label: str) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in allowed:
        allowed_text = ", ".join(sorted(allowed))
        raise UploadValidationError(f"Nicht unterstütztes {label}-Format. Erlaubt: {allowed_text}")
    return suffix


def resolve_allowed_file(path: str, allowed_roots: Iterable[Path]) -> Path:
    raw = Path(path).expanduser()
    if not raw.is_absolute():
        raise UploadValidationError("Lokale Dateipfade müssen absolut sein")
    source = raw.resolve()
    roots = [root.expanduser().resolve() for root in allowed_roots]
    if not any(_is_relative_to(source, root) for root in roots):
        raise UploadPathForbidden("Lokale Datei liegt außerhalb des erlaubten Ordners")
    if not source.is_file():
        raise FileNotFoundError(str(source))
    return source


def require_child_path(path: Path, parent: Path) -> Path:
    resolved_parent = parent.expanduser().resolve()
    resolved_path = path.expanduser().resolve()
    if not _is_relative_to(resolved_path, resolved_parent):
        raise UploadPathForbidden("Ziel liegt außerhalb des erlaubten Ordners")
    return resolved_path


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False

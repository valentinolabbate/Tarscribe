"""Structured, rotating audit log for security-relevant local API activity."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from fastapi import Request

from . import config

LOGGER_NAME = "tarscribe.audit"
_SENSITIVE_FIELD_PARTS = (
    "api_key",
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
)


def _audit_path() -> Path:
    settings = config.get_settings()
    return settings.audit_log_path or settings.logs_dir / "audit.log"


def configure_audit_logger() -> logging.Logger:
    settings = config.get_settings()
    path = _audit_path().expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    max_bytes = max(1, settings.audit_log_max_bytes)
    backup_count = max(1, settings.audit_log_backup_count)
    for handler in list(logger.handlers):
        if not getattr(handler, "_tarscribe_audit_handler", False):
            continue
        same_config = (
            Path(handler.baseFilename) == path
            and handler.maxBytes == max_bytes
            and handler.backupCount == backup_count
        )
        if same_config:
            return logger
        logger.removeHandler(handler)
        handler.close()

    handler = RotatingFileHandler(
        path,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
        delay=True,
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler._tarscribe_audit_handler = True
    logger.addHandler(handler)
    return logger


def _safe_value(key: str, value: Any) -> Any:
    lowered = key.lower()
    if any(part in lowered for part in _SENSITIVE_FIELD_PARTS):
        return "[redacted]"
    if value is None or isinstance(value, (bool, float, int, str)):
        return value
    if isinstance(value, Path):
        return str(value)
    return str(value)


def audit_event(
    action: str,
    *,
    request: Request | None = None,
    outcome: str = "success",
    **fields: Any,
) -> None:
    payload: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "outcome": outcome,
    }
    if request is not None:
        payload.update(
            {
                "method": request.method,
                "path": request.url.path,
                "client": request.client.host if request.client else None,
            }
        )
    payload.update({key: _safe_value(key, value) for key, value in fields.items()})
    try:
        configure_audit_logger().info(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    except OSError:
        logging.getLogger("tarscribe").exception("Audit log could not be written")

"""Opaque cursor helpers shared by compact API endpoints."""

from __future__ import annotations

import base64
import binascii
import json


class CursorError(ValueError):
    pass


def encode_cursor(namespace: str, value: int) -> str:
    payload = json.dumps({"n": namespace, "v": value}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_cursor(cursor: str | None, namespace: str, *, default: int | None = None) -> int | None:
    if cursor is None:
        return default
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode())
        value = payload["v"]
        if payload.get("n") != namespace or not isinstance(value, int) or value < 0:
            raise ValueError
        return value
    except (
        binascii.Error,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        UnicodeDecodeError,
        ValueError,
    ) as exc:
        raise CursorError("Ungültiger oder unpassender Cursor") from exc

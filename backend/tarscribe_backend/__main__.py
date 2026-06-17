"""Sidecar entrypoint.

Started by the Tauri shell with --host/--port/--token, or standalone for dev.
Prints a single JSON line ``{"event":"ready",...}`` to stdout once listening so
the shell can detect readiness.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import secrets
import sys

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="tarscribe-backend")
    parser.add_argument("--host", default=os.environ.get("TARSCRIBE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TARSCRIBE_PORT", "8765")))
    parser.add_argument("--token", default=os.environ.get("TARSCRIBE_AUTH_TOKEN", ""))
    parser.add_argument("--data-dir", default=os.environ.get("TARSCRIBE_DATA_DIR", ""))
    args = parser.parse_args()

    # Push CLI args into the env so get_settings() (cached) picks them up.
    os.environ["TARSCRIBE_HOST"] = args.host
    os.environ["TARSCRIBE_PORT"] = str(args.port)
    # Always run with auth in production: generate a secret if none supplied.
    os.environ["TARSCRIBE_AUTH_TOKEN"] = args.token or secrets.token_urlsafe(32)
    if args.data_dir:
        os.environ["TARSCRIBE_DATA_DIR"] = args.data_dir

    from .config import get_settings

    settings = get_settings()

    # Announce the effective config so the shell knows the token/port.
    print(
        json.dumps(
            {
                "event": "starting",
                "host": settings.host,
                "port": settings.port,
                "token": settings.auth_token,
                "data_dir": str(settings.data_dir),
            }
        ),
        flush=True,
    )

    # Publish a discovery descriptor so an external MCP server can reach this
    # running instance. Best-effort; removed on clean exit (the shell may SIGKILL,
    # so the MCP server also verifies the file via /health).
    from .mcp_link import remove_connection_file, write_connection_file

    write_connection_file(settings)
    atexit.register(remove_connection_file)

    uvicorn.run(
        "tarscribe_backend.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    sys.exit(main())

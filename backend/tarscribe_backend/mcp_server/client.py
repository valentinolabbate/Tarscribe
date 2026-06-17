"""Discovery + HTTP client for the running backend (no ``mcp`` import here, so
this stays unit-testable without the MCP runtime)."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

POLL_INTERVAL = 2.0
DEFAULT_TIMEOUT = 1800.0  # 30 min — long enough for ASR + diarization
TERMINAL = {"done", "failed"}


class BackendUnavailable(RuntimeError):
    """The Tarscribe app isn't reachable (not running, or token rejected)."""


@dataclass
class Connection:
    base_url: str
    token: str


# ── discovery ────────────────────────────────────────────────────────────────
def _connection_path() -> Path:
    override = os.environ.get("TARSCRIBE_MCP_CONNECTION_FILE")
    if override:
        return Path(override)
    from ..config import mcp_connection_path  # lazy: avoids importing config eagerly

    return mcp_connection_path()


def discover() -> Connection:
    """Locate the running backend via env overrides or the connection file."""
    base = os.environ.get("TARSCRIBE_BASE_URL")
    if base:
        return Connection(base.rstrip("/"), os.environ.get("TARSCRIBE_AUTH_TOKEN", ""))

    path = _connection_path()
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise BackendUnavailable(
            "Tarscribe scheint nicht zu laufen (keine Verbindungsdatei gefunden). "
            "Bitte die Tarscribe-App starten und es erneut versuchen."
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise BackendUnavailable(f"Verbindungsdatei unlesbar: {exc}") from exc
    return Connection(str(data["base_url"]).rstrip("/"), str(data.get("token", "")))


# ── HTTP client ──────────────────────────────────────────────────────────────
class BackendClient:
    def __init__(
        self,
        conn: Connection,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._c = httpx.Client(
            base_url=conn.base_url,
            headers={"X-Tarscribe-Token": conn.token},
            timeout=timeout,
            transport=transport,
        )

    def __enter__(self) -> BackendClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._c.close()

    def _request(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = self._c.request(method, path, **kw)
        except httpx.ConnectError as exc:
            raise BackendUnavailable(
                "Verbindung zu Tarscribe fehlgeschlagen — läuft die App noch?"
            ) from exc
        if r.status_code == 401:
            raise BackendUnavailable("Auth-Token abgelehnt — die App wurde vermutlich neu gestartet.")
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} → HTTP {r.status_code}: {r.text[:300]}")
        ctype = r.headers.get("content-type", "")
        return r.json() if ctype.startswith("application/json") else r.text

    # --- read ---------------------------------------------------------------
    def health(self) -> dict:
        return self._request("GET", "/api/system/health")

    def list_topics(self) -> list[dict]:
        return self._request("GET", "/api/topics")

    def list_recordings(self) -> list[dict]:
        return self._request("GET", "/api/recordings")

    def list_known_speakers(self) -> list[dict]:
        return self._request("GET", "/api/known-speakers")

    def get_jobs(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/jobs")

    def get_transcript(self, recording_id: int) -> dict:
        return self._request("GET", f"/api/recordings/{recording_id}/transcript")

    def get_diarization(self, recording_id: int) -> dict:
        return self._request("GET", f"/api/recordings/{recording_id}/diarization")

    # --- write / actions ----------------------------------------------------
    def create_topic(self, name: str, color: str | None = None) -> dict:
        body: dict[str, Any] = {"name": name}
        if color:
            body["color"] = color
        return self._request("POST", "/api/topics", json=body)

    def upload_recording(
        self, file_path: str, topic_id: int, title: str | None = None
    ) -> dict:
        p = Path(file_path).expanduser()
        if not p.is_file():
            raise RuntimeError(f"Audiodatei nicht gefunden: {p}")
        data: dict[str, str] = {"topic_id": str(topic_id)}
        if title:
            data["title"] = title
        with p.open("rb") as fh:
            return self._request(
                "POST", "/api/recordings", data=data, files={"file": (p.name, fh)}
            )

    def transcribe(self, recording_id: int, asr_model: str | None = None) -> dict:
        params = {"asr": asr_model} if asr_model else None
        return self._request("POST", f"/api/recordings/{recording_id}/transcribe", params=params)

    def diarize(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/diarize")

    def match_speakers(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/match")

    # --- job polling --------------------------------------------------------
    def wait_for_job(
        self,
        recording_id: int,
        job_id: int,
        timeout: float,
        *,
        poll: float = POLL_INTERVAL,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> dict:
        deadline = clock() + timeout
        while True:
            job = next(
                (j for j in self.get_jobs(recording_id) if j.get("job_id") == job_id), None
            )
            if job and job.get("status") in TERMINAL:
                if job["status"] == "failed":
                    raise RuntimeError(
                        f"Job {job_id} ({job.get('phase')}) fehlgeschlagen: {job.get('error')}"
                    )
                return job
            if clock() >= deadline:
                raise TimeoutError(f"Job {job_id} wurde nicht innerhalb {timeout:.0f}s fertig.")
            sleep(poll)


# ── orchestrator ─────────────────────────────────────────────────────────────
def process_recording(
    client: BackendClient,
    file_path: str,
    topic_id: int,
    *,
    title: str | None = None,
    asr_model: str | None = None,
    diarize: bool = True,
    match_speakers: bool = True,
    timeout_sec: float = DEFAULT_TIMEOUT,
    **wait_kw: Any,
) -> dict:
    """Run the full pipeline (upload → transcribe → diarize → match) end-to-end."""
    steps: list[dict] = []

    rec = client.upload_recording(file_path, topic_id, title)
    rid = int(rec["id"])
    steps.append({"step": "upload", "recording_id": rid})

    tj = client.transcribe(rid, asr_model)
    client.wait_for_job(rid, int(tj["job_id"]), timeout_sec, **wait_kw)
    steps.append({"step": "transcribe", "job_id": tj["job_id"]})

    matches = None
    if diarize:
        dj = client.diarize(rid)
        client.wait_for_job(rid, int(dj["job_id"]), timeout_sec, **wait_kw)
        steps.append({"step": "diarize", "job_id": dj["job_id"]})
        if match_speakers:
            matches = client.match_speakers(rid).get("matches")
            steps.append({"step": "match_speakers"})

    transcript = client.get_transcript(rid)
    result: dict[str, Any] = {
        "recording_id": rid,
        "transcript_text": transcript.get("text", ""),
        "language": transcript.get("language"),
        "steps": steps,
    }
    if diarize:
        diar = client.get_diarization(rid)
        result["speakers"] = diar.get("speakers")
        result["utterances"] = diar.get("utterances")
    if matches is not None:
        result["speaker_matches"] = matches
    return result

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
DEFAULT_TIMEOUT = 1800.0  # 30 min — long enough for ASR, chapters + diarization
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

    def get_chapters(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/chapters")

    def list_templates(self) -> list[dict]:
        return self._request("GET", "/api/templates")

    def get_summary(self, summary_id: int) -> dict:
        return self._request("GET", f"/api/summaries/{summary_id}")

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

    def generate_chapters(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/chapters/generate")

    def match_speakers(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/match")

    def summarize(self, recording_id: int, template_id: int) -> dict:
        return self._request(
            "POST",
            f"/api/recordings/{recording_id}/summarize",
            params={"template_id": template_id},
        )

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
    detect_chapters: bool = True,
    diarize: bool = True,
    match_speakers: bool = True,
    timeout_sec: float = DEFAULT_TIMEOUT,
    **wait_kw: Any,
) -> dict:
    """Run the full pipeline (upload → transcribe → chapters → diarize → match)."""
    steps: list[dict] = []

    rec = client.upload_recording(file_path, topic_id, title)
    rid = int(rec["id"])
    steps.append({"step": "upload", "recording_id": rid})

    tj = client.transcribe(rid, asr_model)
    client.wait_for_job(rid, int(tj["job_id"]), timeout_sec, **wait_kw)
    steps.append({"step": "transcribe", "job_id": tj["job_id"]})

    if detect_chapters:
        cj = client.generate_chapters(rid)
        client.wait_for_job(rid, int(cj["job_id"]), timeout_sec, **wait_kw)
        steps.append({"step": "detect_chapters", "job_id": cj["job_id"]})

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
    if detect_chapters:
        result["chapters"] = client.get_chapters(rid)
    if diarize:
        diar = client.get_diarization(rid)
        result["speakers"] = diar.get("speakers")
        result["utterances"] = diar.get("utterances")
    if matches is not None:
        result["speaker_matches"] = matches
    return result


def _resolve_template(
    client: BackendClient, template_id: int | None, template_name: str | None
) -> int:
    """Pick a summary template: explicit id wins, then name match, then a default
    (preferring a built-in template, otherwise the first one)."""
    if template_id is not None:
        return template_id
    templates = client.list_templates()
    if not templates:
        raise RuntimeError(
            "Keine Zusammenfassungs-Vorlage vorhanden. Bitte zuerst eine Vorlage anlegen."
        )
    if template_name:
        wanted = template_name.strip().lower()
        match = next(
            (t for t in templates if str(t.get("name", "")).strip().lower() == wanted), None
        )
        if match is None:
            names = ", ".join(str(t.get("name")) for t in templates)
            raise RuntimeError(f"Vorlage '{template_name}' nicht gefunden. Verfügbar: {names}")
        return int(match["id"])
    default = next((t for t in templates if t.get("is_builtin")), templates[0])
    return int(default["id"])


def create_summary(
    client: BackendClient,
    recording_id: int,
    *,
    template_id: int | None = None,
    template_name: str | None = None,
    wait: bool = True,
    timeout_sec: float = 600.0,
    **wait_kw: Any,
) -> dict:
    """Generate a summary for a recording, optionally with a specific template.

    Blocks until the summary is ready (``wait``) and returns its content; set
    ``wait=False`` to return immediately with the job id to poll via get_jobs.
    """
    tpl_id = _resolve_template(client, template_id, template_name)
    started = client.summarize(recording_id, tpl_id)
    summary_id = int(started["summary_id"])
    job_id = int(started["job_id"])
    result: dict[str, Any] = {
        "recording_id": recording_id,
        "summary_id": summary_id,
        "template_id": tpl_id,
        "job_id": job_id,
    }
    if not wait:
        result["status"] = "running"
        return result

    client.wait_for_job(recording_id, job_id, timeout_sec, **wait_kw)
    summary = client.get_summary(summary_id)
    sources_raw = summary.get("sources")
    if isinstance(sources_raw, str) and sources_raw:
        try:
            sources_raw = json.loads(sources_raw)
        except json.JSONDecodeError:
            sources_raw = None
    result.update(
        status="done",
        content=summary.get("content", ""),
        model=summary.get("model"),
        sources=sources_raw or [],
    )
    return result


def export_summary(client: BackendClient, summary_id: int, file_path: str) -> dict:
    """Write a summary's Markdown content to ``file_path``. Returns the path."""
    summary = client.get_summary(summary_id)
    content = (summary.get("content") or "").strip()
    if not content:
        raise RuntimeError(
            f"Zusammenfassung {summary_id} hat noch keinen Inhalt — ist der Job fertig?"
        )
    target = Path(file_path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"path": str(target), "bytes": len(content.encode("utf-8"))}

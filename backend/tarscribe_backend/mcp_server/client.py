"""Discovery + HTTP client for the running backend (no ``mcp`` import here, so
this stays unit-testable without the MCP runtime)."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
    toolset: str = "focused"


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
        return Connection(
            base.rstrip("/"),
            os.environ.get("TARSCRIBE_AUTH_TOKEN", ""),
            os.environ.get("TARSCRIBE_MCP_TOOLSET", "focused"),
        )

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
    return Connection(
        str(data["base_url"]).rstrip("/"),
        str(data.get("token", "")),
        str(data.get("toolset", "focused")),
    )


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

    def list_recordings(
        self,
        *,
        topic_id: int | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit}
        if topic_id is not None:
            params["topic_id"] = topic_id
        if cursor is not None:
            params["cursor"] = cursor
        return self._request("GET", "/api/recordings/page", params=params)

    def list_all_recordings(self) -> list[dict]:
        return self._request("GET", "/api/recordings")

    def get_recording(self, recording_id: int) -> dict:
        return self._request("GET", f"/api/recordings/{recording_id}")

    def list_known_speakers(self) -> list[dict]:
        return self._request("GET", "/api/known-speakers")

    def get_jobs(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/jobs")

    def get_transcript(self, recording_id: int) -> dict:
        return self._request("GET", f"/api/recordings/{recording_id}/transcript")

    def get_transcript_context(
        self,
        recording_id: int,
        *,
        start_sec: float | None = None,
        end_sec: float | None = None,
        cursor: str | None = None,
        limit: int = 500,
        include_words: bool = False,
    ) -> dict:
        params: dict[str, Any] = {
            "limit": limit,
            "include_words": str(include_words).lower(),
        }
        for key, value in {
            "start_sec": start_sec,
            "end_sec": end_sec,
            "cursor": cursor,
        }.items():
            if value is not None:
                params[key] = value
        return self._request(
            "GET",
            f"/api/recordings/{recording_id}/transcript/context",
            params=params,
        )

    def get_diarization(self, recording_id: int) -> dict:
        return self._request("GET", f"/api/recordings/{recording_id}/diarization")

    def get_chapters(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/chapters")

    def list_templates(self) -> list[dict]:
        return self._request("GET", "/api/templates")

    def list_summaries(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/summaries")

    def get_summary(self, summary_id: int) -> dict:
        return self._request("GET", f"/api/summaries/{summary_id}")

    def list_action_items(
        self, topic_id: int | None = None, done: bool | None = None
    ) -> list[dict]:
        params: dict[str, Any] = {}
        if topic_id is not None:
            params["topic_id"] = topic_id
        if done is not None:
            params["done"] = str(done).lower()
        return self._request("GET", "/api/action-items", params=params or None)

    def list_recording_action_items(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/action-items")

    def list_recording_threads(self, recording_id: int) -> list[dict]:
        return self._request("GET", f"/api/recordings/{recording_id}/threads")

    def get_memory_overview(
        self,
        *,
        topic_id: int | None = None,
        mine_only: bool = False,
        attention_limit: int = 10,
    ) -> dict:
        params: dict[str, Any] = {
            "mine_only": str(mine_only).lower(),
            "attention_limit": attention_limit,
        }
        if topic_id is not None:
            params["topic_id"] = topic_id
        return self._request("GET", "/api/memory/overview", params=params)

    def list_memory_items(
        self,
        *,
        kind: str | None = None,
        topic_id: int | None = None,
        recording_id: int | None = None,
        done: bool | None = None,
        review_state: str | None = None,
        decision_status: str | None = None,
        mine_only: bool = False,
        involved_only: bool = False,
        attention: str | None = None,
        due_before: str | None = None,
        query: str | None = None,
        include_rejected: bool = False,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict:
        params: dict[str, Any] = {
            "mine_only": str(mine_only).lower(),
            "involved_only": str(involved_only).lower(),
            "include_rejected": str(include_rejected).lower(),
            "limit": limit,
        }
        values = {
            "kind": kind,
            "topic_id": topic_id,
            "recording_id": recording_id,
            "review_state": review_state,
            "decision_status": decision_status,
            "attention": attention,
            "due_before": due_before,
            "query": query,
            "cursor": cursor,
        }
        params.update({key: value for key, value in values.items() if value is not None})
        if done is not None:
            params["done"] = str(done).lower()
        return self._request("GET", "/api/memory/items", params=params)

    def get_memory_item(self, item_id: int) -> dict:
        return self._request("GET", f"/api/memory/items/{item_id}")

    def get_people_memory(
        self,
        speaker_id: int,
        *,
        include_recordings: bool = True,
        include_tasks: bool = True,
        include_decisions: bool = True,
        include_threads: bool = True,
        limit: int = 10,
        thread_mention_limit: int = 5,
    ) -> dict:
        return self._request(
            "GET",
            f"/api/known-speakers/{speaker_id}/memory",
            params={
                "include_recordings": str(include_recordings).lower(),
                "include_tasks": str(include_tasks).lower(),
                "include_decisions": str(include_decisions).lower(),
                "include_threads": str(include_threads).lower(),
                "limit": limit,
                "thread_mention_limit": thread_mention_limit,
            },
        )

    def list_thread_summaries(
        self,
        *,
        topic_id: int | None = None,
        recorded_after: str | None = None,
        cursor: str | None = None,
        limit: int = 10,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        if topic_id is not None:
            params["topic_id"] = topic_id
        if recorded_after is not None:
            params["recorded_after"] = recorded_after
        return self._request("GET", "/api/threads/page", params=params)

    def get_thread(
        self,
        thread_id: int,
        *,
        topic_id: int | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        if topic_id is not None:
            params["topic_id"] = topic_id
        return self._request("GET", f"/api/threads/{thread_id}", params=params)

    def semantic_search(
        self,
        query: str,
        *,
        topic_id: int | None = None,
        recording_id: int | None = None,
        include_topic_context: bool = False,
        top_k: int | None = None,
        speaker: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "query": query,
            "include_topic_context": include_topic_context,
        }
        for key, value in {
            "topic_id": topic_id,
            "recording_id": recording_id,
            "top_k": top_k,
            "speaker": speaker,
            "date_from": date_from,
            "date_to": date_to,
        }.items():
            if value is not None:
                body[key] = value
        return self._request("POST", "/api/rag/search", json=body)

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

    def extract_action_items(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/action-items/extract")

    def export_recording_note(self, recording_id: int) -> dict:
        return self._request("POST", f"/api/recordings/{recording_id}/send-to-folder")

    def update_action_item(
        self,
        item_id: int,
        *,
        done: bool | None = None,
        text: str | None = None,
        assignee: str | None = None,
        due: str | None = None,
        due_date: str | None = None,
        include_in_tasks: bool | None = None,
    ) -> dict:
        patch = {
            key: value
            for key, value in {
                "done": done,
                "text": text,
                "assignee": assignee,
                "due": due,
                "due_date": due_date,
                "include_in_tasks": include_in_tasks,
            }.items()
            if value is not None
        }
        if not patch:
            raise RuntimeError("Keine Änderung übergeben.")
        return self._request("PATCH", f"/api/action-items/{item_id}", json=patch)

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

    def wait_for_jobs(
        self,
        recording_id: int,
        *,
        job_ids: list[int] | None = None,
        phases: list[str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        poll: float = POLL_INTERVAL,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> dict:
        """Wait until matching jobs for a recording are no longer active."""
        wanted_ids = {int(job_id) for job_id in job_ids or []}
        wanted_phases = {str(phase) for phase in phases or []}
        deadline = clock() + timeout
        terminal = TERMINAL | {"canceled"}
        while True:
            jobs = self.get_jobs(recording_id)
            if wanted_ids or wanted_phases:
                matches = [
                    j
                    for j in jobs
                    if (not wanted_ids or int(j.get("job_id", -1)) in wanted_ids)
                    and (not wanted_phases or str(j.get("phase")) in wanted_phases)
                ]
            else:
                matches = [j for j in jobs if j.get("status") not in terminal]
                failed = [j for j in jobs if j.get("status") in {"failed", "canceled"}]
                if failed:
                    raise RuntimeError(
                        f"Job {failed[0].get('job_id')} ({failed[0].get('phase')}) "
                        f"fehlgeschlagen: {failed[0].get('error') or failed[0].get('status')}"
                    )
                if not matches:
                    return {"status": "done", "jobs": jobs}

            if not matches and (wanted_ids or wanted_phases):
                return {"status": "missing", "jobs": []}
            failed = [j for j in matches if j.get("status") in {"failed", "canceled"}]
            if failed:
                raise RuntimeError(
                    f"Job {failed[0].get('job_id')} ({failed[0].get('phase')}) "
                    f"fehlgeschlagen: {failed[0].get('error') or failed[0].get('status')}"
                )
            if all(j.get("status") == "done" for j in matches):
                return {"status": "done", "jobs": matches}
            if clock() >= deadline:
                raise TimeoutError(
                    f"Aufträge für Aufnahme {recording_id} wurden nicht innerhalb "
                    f"{timeout:.0f}s fertig."
                )
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


def get_recording_context(
    client: BackendClient,
    recording_id: int,
    *,
    include_transcript: bool = True,
    include_diarization: bool = False,
    include_chapters: bool = True,
    include_summaries: bool = True,
    include_action_items: bool = True,
    include_threads: bool = True,
) -> dict:
    """Collect the useful context an agent usually needs for one recording."""

    def optional(section: str, load: Callable[[], Any]) -> Any:
        try:
            return load()
        except RuntimeError as exc:
            return {"error": f"{section} nicht verfügbar: {exc}"}

    payload: dict[str, Any] = {
        "recording": client.get_recording(recording_id),
        "jobs": client.get_jobs(recording_id)[-20:],
    }
    if include_transcript:
        payload["transcript"] = optional(
            "Transkript",
            lambda: client.get_transcript_context(recording_id, limit=500, include_words=False),
        )
    if include_diarization:
        payload["diarization"] = optional(
            "Diarisierung", lambda: client.get_diarization(recording_id)
        )
    if include_chapters:
        payload["chapters"] = optional("Kapitel", lambda: client.get_chapters(recording_id))
    if include_summaries:
        summaries = optional("Zusammenfassungen", lambda: client.list_summaries(recording_id))
        if isinstance(summaries, list):
            summaries = [
                {
                    **summary,
                    "content": str(summary.get("content") or "")[:4000],
                    "truncated": len(str(summary.get("content") or "")) > 4000,
                }
                for summary in summaries[:5]
            ]
        payload["summaries"] = summaries
    if include_action_items:
        payload["memory_items"] = optional(
            "Gedächtnis",
            lambda: client.list_memory_items(recording_id=recording_id, limit=20),
        )
    if include_threads:
        threads = optional("Threads", lambda: client.list_recording_threads(recording_id))
        if isinstance(threads, list):
            threads = [
                {
                    **{key: value for key, value in thread.items() if key != "mentions"},
                    "mentions": list(thread.get("mentions") or [])[:3],
                }
                for thread in threads[:10]
            ]
        payload["threads"] = threads
    return payload


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


def prepare_meeting(
    client: BackendClient,
    *,
    topic_id: int | None = None,
    speaker_ids: list[int] | None = None,
    lookback_days: int = 90,
    item_limit: int = 15,
    thread_limit: int = 8,
) -> dict:
    selected_speakers = list(dict.fromkeys(speaker_ids or []))
    if len(selected_speakers) > 5:
        raise RuntimeError("Höchstens fünf Personen können gleichzeitig vorbereitet werden.")
    if not 1 <= lookback_days <= 3650:
        raise RuntimeError("lookback_days muss zwischen 1 und 3650 liegen.")
    if not 1 <= item_limit <= 50:
        raise RuntimeError("item_limit muss zwischen 1 und 50 liegen.")
    if not 1 <= thread_limit <= 50:
        raise RuntimeError("thread_limit muss zwischen 1 und 50 liegen.")
    recorded_after = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    return {
        "scope": {
            "topic_id": topic_id,
            "speaker_ids": selected_speakers,
            "lookback_days": lookback_days,
        },
        "overview": client.get_memory_overview(
            topic_id=topic_id,
            attention_limit=min(item_limit, 8),
        ),
        "open_commitments": client.list_memory_items(
            kind="task",
            topic_id=topic_id,
            done=False,
            limit=item_limit,
        ),
        "current_decisions": client.list_memory_items(
            kind="decision",
            topic_id=topic_id,
            decision_status="current",
            limit=item_limit,
        ),
        "people": [
            client.get_people_memory(
                speaker_id,
                include_tasks=False,
                include_decisions=False,
                limit=min(item_limit, 20),
                thread_mention_limit=3,
            )
            for speaker_id in selected_speakers
        ],
        "recent_threads": client.list_thread_summaries(
            topic_id=topic_id,
            recorded_after=recorded_after,
            limit=thread_limit,
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def analyze_recording(
    client: BackendClient,
    recording_id: int,
    *,
    template_id: int | None = None,
    template_name: str | None = None,
    create_summary: bool = True,
    extract_action_items: bool = True,
    detect_chapters: bool = False,
    wait: bool = True,
    timeout_sec: float = 900.0,
    **wait_kw: Any,
) -> dict:
    """Run the post-processing agents usually want for an existing recording."""
    steps: list[dict[str, Any]] = []
    result: dict[str, Any] = {"recording_id": recording_id, "steps": steps}

    if detect_chapters:
        current = client.get_chapters(recording_id)
        if current:
            steps.append({"step": "detect_chapters", "status": "already_present"})
        else:
            job = client.generate_chapters(recording_id)
            steps.append({"step": "detect_chapters", "job_id": job.get("job_id")})
            if wait:
                client.wait_for_job(recording_id, int(job["job_id"]), timeout_sec, **wait_kw)
        result["chapters"] = client.get_chapters(recording_id)

    if extract_action_items:
        job = client.extract_action_items(recording_id)
        steps.append({"step": "extract_action_items", "job_id": job.get("job_id")})
        if wait:
            client.wait_for_job(recording_id, int(job["job_id"]), timeout_sec, **wait_kw)
        result["action_items"] = client.list_recording_action_items(recording_id)

    if create_summary:
        summary = create_summary_for_recording(
            client,
            recording_id,
            template_id=template_id,
            template_name=template_name,
            wait=wait,
            timeout_sec=timeout_sec,
            **wait_kw,
        )
        steps.append(
            {
                "step": "create_summary",
                "summary_id": summary.get("summary_id"),
                "status": summary.get("status"),
            }
        )
        result["summary"] = summary

    result["context"] = get_recording_context(
        client,
        recording_id,
        include_transcript=True,
        include_diarization=True,
        include_chapters=True,
        include_summaries=True,
        include_action_items=True,
        include_threads=True,
    )
    return result


# Internal alias used by analyze_recording; keeping the public function name
# create_summary preserves the existing MCP helper API.
create_summary_for_recording = create_summary

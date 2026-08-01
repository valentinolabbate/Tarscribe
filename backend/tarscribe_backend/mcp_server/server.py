"""FastMCP tool definitions — thin wrappers over :mod:`client`."""

from __future__ import annotations

import json
import os
from datetime import date, datetime
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field
from typing_extensions import TypedDict

from .client import BackendClient, discover, process_recording
from .client import analyze_recording as _analyze_recording
from .client import create_summary as _create_summary
from .client import get_recording_context as _get_recording_context
from .client import prepare_meeting as _prepare_meeting

mcp = FastMCP("Tarscribe")

_CAPABILITY_LABELS = {
    "upload": "Upload & Pipeline",
    "context": "Kontext abrufen",
    "search": "Suche",
    "tasks": "Aufgaben",
    "memory": "Gedächtnis",
    "people": "Personen",
    "threads": "Themen-Threads",
    "analysis": "Analyse",
    "export": "Export",
}
_TOOL_CAPABILITIES: dict[str, str] = {}
_TOOL_PROFILES: dict[str, set[str]] = {}


class PageResult(TypedDict):
    items: list[dict[str, Any]]
    count: int
    has_more: bool
    next_cursor: str | None


class JobSubmission(TypedDict, total=False):
    recording_id: int
    job_id: int
    summary_id: int
    status: str
    jobs: list[dict[str, Any]]
    message: str


class RecordingContext(TypedDict, total=False):
    recording: dict[str, Any]
    jobs: list[dict[str, Any]]
    transcript: dict[str, Any]
    diarization: dict[str, Any]
    chapters: list[dict[str, Any]] | dict[str, Any]
    summaries: list[dict[str, Any]] | dict[str, Any]
    memory_items: dict[str, Any]
    threads: list[dict[str, Any]] | dict[str, Any]


class TranscriptResult(TypedDict, total=False):
    transcript_id: int
    asr_model: str
    language: str | None
    revision: int
    text: str
    start_sec: float | None
    end_sec: float | None
    total_word_count: int
    returned_word_count: int
    has_more: bool
    next_cursor: str | None
    words: list[dict[str, Any]]


PositiveId = Annotated[int, Field(gt=0)]
PageLimit = Annotated[int, Field(ge=1, le=50)]
TranscriptLimit = Annotated[int, Field(ge=1, le=2000)]


def _active_toolset() -> Literal["focused", "full"]:
    configured = os.environ.get("TARSCRIBE_MCP_TOOLSET")
    if configured is None:
        try:
            configured = discover().toolset
        except Exception:
            configured = "focused"
    return "full" if configured == "full" else "focused"


ACTIVE_TOOLSET = _active_toolset()


def _tool(
    capability: str,
    *,
    read_only: bool,
    destructive: bool = False,
    idempotent: bool | None = None,
    open_world: bool = False,
    profiles: tuple[Literal["focused", "full"], ...] = ("focused", "full"),
):
    def decorate(function: Any) -> Any:
        _TOOL_CAPABILITIES[function.__name__] = capability
        _TOOL_PROFILES[function.__name__] = set(profiles)
        if ACTIVE_TOOLSET not in profiles:
            return function
        annotations = ToolAnnotations(
            readOnlyHint=read_only,
            destructiveHint=destructive,
            idempotentHint=read_only if idempotent is None else idempotent,
            openWorldHint=open_world,
        )
        return mcp.tool(
            annotations=annotations,
            meta={"tarscribe": {"capability": capability}},
        )(function)

    return decorate


def capability_rows(tool_names: set[str]) -> list[dict]:
    return [
        {
            "id": capability,
            "label": label,
            "ready": all(name in tool_names for name in names),
            "tools": names,
        }
        for capability, label in _CAPABILITY_LABELS.items()
        if (
            names := sorted(
                name
                for name, assigned in _TOOL_CAPABILITIES.items()
                if assigned == capability and name in tool_names
            )
        )
    ]


def toolset_summary() -> dict[str, Any]:
    focused = sorted(name for name, profiles in _TOOL_PROFILES.items() if "focused" in profiles)
    full = sorted(name for name, profiles in _TOOL_PROFILES.items() if "full" in profiles)
    return {
        "active": ACTIVE_TOOLSET,
        "focused_count": len(focused),
        "full_count": len(full),
        "focused_tools": focused,
        "full_tools": full,
    }


def _client() -> BackendClient:
    """A fresh client bound to the currently running app (cheap; per call)."""
    return BackendClient(discover())


# ── discovery / read ─────────────────────────────────────────────────────────
@_tool("context", read_only=True)
def list_topics() -> list[dict[str, Any]]:
    """List the topic areas (Themenbereiche). Recordings must belong to one."""
    with _client() as c:
        return c.list_topics()


@_tool("upload", read_only=False, idempotent=False)
def create_topic(name: Annotated[str, Field(min_length=1, max_length=120)], color: str | None = None) -> dict[str, Any]:
    """Create a new topic area and return it (use its id for uploads)."""
    with _client() as c:
        return c.create_topic(name, color)


@_tool("context", read_only=True)
def list_recordings(
    topic_id: PositiveId | None = None,
    cursor: str | None = None,
    limit: PageLimit = 20,
) -> PageResult:
    """List recordings in compact pages. Pass next_cursor unchanged to continue."""
    with _client() as c:
        return c.list_recordings(topic_id=topic_id, cursor=cursor, limit=limit)


@_tool("people", read_only=True)
def list_people() -> list[dict[str, Any]]:
    """List enrolled speakers that diarized speakers can be matched against."""
    with _client() as c:
        return c.list_known_speakers()


@_tool("people", read_only=True, profiles=("full",))
def list_known_speakers() -> list[dict[str, Any]]:
    """Legacy alias for list_people."""
    with _client() as c:
        return c.list_known_speakers()


@_tool("analysis", read_only=True)
def get_job_status(recording_id: PositiveId) -> list[dict[str, Any]]:
    """Job status (phase/status/progress/error) for a recording."""
    with _client() as c:
        return c.get_jobs(recording_id)


@_tool("analysis", read_only=True, profiles=("full",))
def get_jobs(recording_id: PositiveId) -> list[dict[str, Any]]:
    """Legacy alias for get_job_status."""
    with _client() as c:
        return c.get_jobs(recording_id)


@_tool("analysis", read_only=True, profiles=("full",))
def wait_for_jobs(
    recording_id: PositiveId,
    job_ids: list[int] | None = None,
    phases: list[str] | None = None,
    timeout_sec: float = 1800.0,
) -> dict[str, Any]:
    """Wait until matching jobs for a recording finish. Use job_ids for exact
    jobs, phases like ["asr", "summarize", "action_items"] for job phases, or
    no filters to wait until the recording has no active jobs."""
    with _client() as c:
        return c.wait_for_jobs(
            recording_id,
            job_ids=job_ids,
            phases=phases,
            timeout=timeout_sec,
        )


@_tool("context", read_only=True)
def get_transcript(
    recording_id: PositiveId,
    start_sec: Annotated[float, Field(ge=0)] | None = None,
    end_sec: Annotated[float, Field(gt=0)] | None = None,
    cursor: str | None = None,
    limit: TranscriptLimit = 500,
    include_words: bool = False,
) -> TranscriptResult:
    """Fetch a bounded transcript slice. Text is included by default; detailed
    word timings are opt-in. Pass next_cursor unchanged to continue."""
    with _client() as c:
        return c.get_transcript_context(
            recording_id,
            start_sec=start_sec,
            end_sec=end_sec,
            cursor=cursor,
            limit=limit,
            include_words=include_words,
        )


@_tool("context", read_only=True, profiles=("full",))
def get_diarization(recording_id: PositiveId) -> dict[str, Any]:
    """Fetch speaker-attributed utterances + speaker list for a recording."""
    with _client() as c:
        return c.get_diarization(recording_id)


@_tool("context", read_only=True)
def get_chapters(recording_id: PositiveId) -> list[dict[str, Any]]:
    """Fetch detected chapters for a recording."""
    with _client() as c:
        return c.get_chapters(recording_id)


@_tool("context", read_only=True)
def list_summaries(recording_id: PositiveId) -> list[dict[str, Any]]:
    """List generated summaries for a recording, newest first."""
    with _client() as c:
        return c.list_summaries(recording_id)


@_tool("tasks", read_only=True, profiles=("full",))
def list_action_items(
    topic_id: int | None = None,
    recording_id: int | None = None,
    done: bool | None = None,
    mine_only: bool = False,
    include_decisions: bool = True,
) -> list[dict[str, Any]]:
    """List tasks/decisions across Tarscribe. Filter by topic, recording, done
    state, or only items assigned/pinned to the configured "me" speaker."""
    with _client() as c:
        items = (
            c.list_recording_action_items(recording_id)
            if recording_id is not None
            else c.list_action_items(topic_id=topic_id, done=done)
        )
    if done is not None and recording_id is not None:
        items = [item for item in items if item.get("done") is done]
    if mine_only:
        items = [item for item in items if item.get("is_mine") or item.get("include_in_tasks")]
    if not include_decisions:
        items = [item for item in items if item.get("kind") != "decision"]
    return items


@_tool("tasks", read_only=False, idempotent=True, profiles=("full",))
def update_action_item(
    item_id: int,
    done: bool | None = None,
    text: str | None = None,
    assignee: str | None = None,
    due: str | None = None,
    due_date: str | None = None,
    include_in_tasks: bool | None = None,
) -> dict[str, Any]:
    """Update a task/decision. Pass only fields that should change. Use an empty
    due_date string to clear a date."""
    with _client() as c:
        return c.update_action_item(
            item_id,
            done=done,
            text=text,
            assignee=assignee,
            due=due,
            due_date=due_date,
            include_in_tasks=include_in_tasks,
        )


@_tool("memory", read_only=False, idempotent=True)
def update_memory_item(
    item_id: PositiveId,
    done: bool | None = None,
    text: Annotated[str, Field(max_length=2000)] | None = None,
    assignee: Annotated[str, Field(max_length=200)] | None = None,
    due: Annotated[str, Field(max_length=200)] | None = None,
    due_date: date | None = None,
    clear_due_date: bool = False,
    include_in_tasks: bool | None = None,
) -> dict[str, Any]:
    """Update one commitment or decision. Use clear_due_date to remove its date."""
    with _client() as c:
        return c.update_action_item(
            item_id,
            done=done,
            text=text,
            assignee=assignee,
            due=due,
            due_date="" if clear_due_date else due_date.isoformat() if due_date else None,
            include_in_tasks=include_in_tasks,
        )


@_tool("memory", read_only=True)
def get_memory_overview(
    topic_id: PositiveId | None = None,
    mine_only: bool = False,
    attention_limit: Annotated[int, Field(ge=1, le=25)] = 10,
) -> dict[str, Any]:
    """Return compact project-memory statistics and the most urgent sourced
    commitments or decisions without loading the full ledger."""
    with _client() as c:
        return c.get_memory_overview(
            topic_id=topic_id,
            mine_only=mine_only,
            attention_limit=attention_limit,
        )


@_tool("memory", read_only=True)
def list_memory_items(
    kind: Literal["task", "decision"] | None = None,
    topic_id: PositiveId | None = None,
    recording_id: PositiveId | None = None,
    done: bool | None = None,
    review_state: Literal["pending", "confirmed", "rejected"] | None = None,
    decision_status: Literal["proposed", "current", "superseded", "rejected"] | None = None,
    mine_only: bool = False,
    involved_only: bool = False,
    attention: Literal[
        "needs_review",
        "low_confidence",
        "missing_source",
        "needs_evidence_review",
        "missing_owner",
        "missing_due",
        "overdue",
        "due_soon",
    ]
    | None = None,
    due_before: date | None = None,
    query: Annotated[str, Field(max_length=200)] | None = None,
    include_rejected: bool = False,
    cursor: str | None = None,
    limit: PageLimit = 20,
) -> PageResult:
    """List source-backed commitments and decisions with filters and cursor
    pagination. Pass next_cursor from the previous response to continue."""
    with _client() as c:
        return c.list_memory_items(
            kind=kind,
            topic_id=topic_id,
            recording_id=recording_id,
            done=done,
            review_state=review_state,
            decision_status=decision_status,
            mine_only=mine_only,
            involved_only=involved_only,
            attention=attention,
            due_before=due_before.isoformat() if due_before else None,
            query=query,
            include_rejected=include_rejected,
            cursor=cursor,
            limit=limit,
        )


@_tool("memory", read_only=True)
def get_memory_item(item_id: PositiveId) -> dict[str, Any]:
    """Fetch one complete commitment or decision including source quote,
    recording, topic, timestamp, review state, and attention flags."""
    with _client() as c:
        return c.get_memory_item(item_id)


@_tool("people", read_only=True)
def get_person_memory(
    speaker_id: PositiveId,
    include_recordings: bool = True,
    include_tasks: bool = True,
    include_decisions: bool = True,
    include_threads: bool = True,
    limit: PageLimit = 10,
    thread_mention_limit: Annotated[int, Field(ge=1, le=20)] = 5,
) -> dict[str, Any]:
    """Fetch source-backed meeting history, commitments, decisions, and recurring
    threads for one known speaker. Use list_people to resolve the id."""
    with _client() as c:
        return c.get_people_memory(
            speaker_id,
            include_recordings=include_recordings,
            include_tasks=include_tasks,
            include_decisions=include_decisions,
            include_threads=include_threads,
            limit=limit,
            thread_mention_limit=thread_mention_limit,
        )


@_tool("threads", read_only=True)
def list_threads(
    topic_id: PositiveId | None = None,
    recorded_after: datetime | None = None,
    cursor: str | None = None,
    limit: PageLimit = 10,
) -> PageResult:
    """List compact recurring-topic summaries. recorded_after accepts an ISO
    timestamp; pass next_cursor from the previous response to continue."""
    with _client() as c:
        return c.list_thread_summaries(
            topic_id=topic_id,
            recorded_after=recorded_after.isoformat() if recorded_after else None,
            cursor=cursor,
            limit=limit,
        )


@_tool("threads", read_only=True)
def get_thread(
    thread_id: PositiveId,
    topic_id: PositiveId | None = None,
    cursor: str | None = None,
    limit: PageLimit = 20,
) -> dict[str, Any]:
    """Fetch one recurring topic with paginated, timestamped source mentions."""
    with _client() as c:
        return c.get_thread(thread_id, topic_id=topic_id, cursor=cursor, limit=limit)


@_tool("memory", read_only=True)
def prepare_meeting(
    topic_id: PositiveId | None = None,
    speaker_ids: Annotated[list[PositiveId], Field(max_length=5)] | None = None,
    lookback_days: Annotated[int, Field(ge=1, le=3650)] = 90,
    item_limit: PageLimit = 15,
    thread_limit: PageLimit = 8,
) -> dict[str, Any]:
    """Build a compact, source-backed meeting brief with open commitments,
    current decisions, selected people, and recent recurring topics."""
    with _client() as c:
        return _prepare_meeting(
            c,
            topic_id=topic_id,
            speaker_ids=speaker_ids,
            lookback_days=lookback_days,
            item_limit=item_limit,
            thread_limit=thread_limit,
        )


@_tool("search", read_only=True, open_world=True)
def search_knowledge(
    query: Annotated[str, Field(min_length=1, max_length=1000)],
    topic_id: PositiveId | None = None,
    recording_id: PositiveId | None = None,
    include_topic_context: bool = False,
    top_k: Annotated[int, Field(ge=1, le=50)] | None = None,
    speaker: Annotated[str, Field(max_length=200)] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any]:
    """Search transcript, summary, and document chunks with Tarscribe's semantic
    search index. Requires RAG/search to be enabled in Tarscribe."""
    with _client() as c:
        return c.semantic_search(
            query,
            topic_id=topic_id,
            recording_id=recording_id,
            include_topic_context=include_topic_context,
            top_k=top_k,
            speaker=speaker,
            date_from=date_from.isoformat() if date_from else None,
            date_to=date_to.isoformat() if date_to else None,
        )


@_tool("search", read_only=True, open_world=True, profiles=("full",))
def search_recordings(
    query: str,
    topic_id: int | None = None,
    recording_id: int | None = None,
    include_topic_context: bool = False,
    top_k: int | None = None,
    speaker: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Legacy alias for search_knowledge."""
    with _client() as c:
        return c.semantic_search(
            query,
            topic_id=topic_id,
            recording_id=recording_id,
            include_topic_context=include_topic_context,
            top_k=top_k,
            speaker=speaker,
            date_from=date_from,
            date_to=date_to,
        )


@_tool("context", read_only=True)
def get_recording_context(
    recording_id: PositiveId,
    include_transcript: bool = True,
    include_diarization: bool = False,
    include_chapters: bool = True,
    include_summaries: bool = True,
    include_action_items: bool = True,
    include_threads: bool = True,
) -> RecordingContext:
    """Fetch bounded working context for one recording. Transcript words and
    diarization are excluded by default so the result stays agent-friendly."""
    with _client() as c:
        return _get_recording_context(
            c,
            recording_id,
            include_transcript=include_transcript,
            include_diarization=include_diarization,
            include_chapters=include_chapters,
            include_summaries=include_summaries,
            include_action_items=include_action_items,
            include_threads=include_threads,
        )


@_tool("analysis", read_only=True, profiles=("full",))
def list_templates() -> list[dict[str, Any]]:
    """List summary templates. Pass a template's id to create_summary to use it."""
    with _client() as c:
        return c.list_templates()


# ── actions ──────────────────────────────────────────────────────────────────
@_tool("upload", read_only=False, idempotent=False, profiles=("full",))
def upload_recording(file_path: str, topic_id: int, title: str | None = None) -> dict[str, Any]:
    """Upload a local audio file into a topic. Returns the created recording."""
    with _client() as c:
        return c.upload_recording(file_path, topic_id, title)


@_tool("upload", read_only=False, idempotent=False, profiles=("full",))
def start_transcription(recording_id: int, asr_model: str | None = None) -> dict[str, Any]:
    """Queue transcription (ASR). Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.transcribe(recording_id, asr_model)


@_tool("upload", read_only=False, idempotent=False, profiles=("full",))
def start_diarization(recording_id: int) -> dict[str, Any]:
    """Queue speaker diarization. Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.diarize(recording_id)


@_tool("upload", read_only=False, idempotent=False, profiles=("full",))
def start_chapter_detection(recording_id: int) -> dict[str, Any]:
    """Queue automatic chapter detection. Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.generate_chapters(recording_id)


@_tool("upload", read_only=False, idempotent=False, profiles=("full",))
def match_speakers(recording_id: int) -> dict[str, Any]:
    """Match this recording's diarized speakers against the known-speaker library."""
    with _client() as c:
        return c.match_speakers(recording_id)


@_tool("upload", read_only=False, idempotent=False)
def import_and_process_recording(
    file_path: str,
    topic_id: PositiveId,
    title: Annotated[str, Field(max_length=300)] | None = None,
    asr_model: Annotated[str, Field(max_length=200)] | None = None,
) -> JobSubmission:
    """Import audio and queue transcription without blocking. Tarscribe's normal
    pipeline continues with diarization and memory extraction when configured;
    poll get_job_status with the returned recording id."""
    with _client() as c:
        recording = c.upload_recording(file_path, topic_id, title)
        recording_id = int(recording["id"])
        job = c.transcribe(recording_id, asr_model)
        return {
            "recording_id": recording_id,
            "job_id": int(job["job_id"]),
            "status": str(job.get("status") or "queued"),
            "message": "Transkription gestartet; Status mit get_job_status abrufen.",
        }


@_tool(
    "upload",
    read_only=False,
    idempotent=False,
    open_world=True,
    profiles=("full",),
)
def process_recording_pipeline(
    file_path: str,
    topic_id: int,
    title: str | None = None,
    asr_model: str | None = None,
    detect_chapters: bool = True,
    diarize: bool = True,
    match_speakers: bool = True,
    create_summary: bool = False,
    template_id: int | None = None,
    template_name: str | None = None,
    extract_action_items: bool = False,
    timeout_sec: float = 1800.0,
) -> dict[str, Any]:
    """End-to-end: upload → transcribe → chapters → (diarize → match speakers)
    and optionally summary/action extraction, blocking until done. Returns the
    processed context for one-shot autonomous handling of a single audio file."""
    with _client() as c:
        result = process_recording(
            c,
            file_path,
            topic_id,
            title=title,
            asr_model=asr_model,
            detect_chapters=detect_chapters,
            diarize=diarize,
            match_speakers=match_speakers,
            timeout_sec=timeout_sec,
        )
        recording_id = int(result["recording_id"])
        if extract_action_items:
            job = c.extract_action_items(recording_id)
            c.wait_for_job(recording_id, int(job["job_id"]), timeout_sec)
            result["action_items"] = c.list_recording_action_items(recording_id)
        if create_summary:
            result["summary"] = _create_summary(
                c,
                recording_id,
                template_id=template_id,
                template_name=template_name,
                wait=True,
                timeout_sec=timeout_sec,
            )
        return result


@_tool("analysis", read_only=False, idempotent=False)
def process_existing_recording(
    recording_id: PositiveId,
    template_id: PositiveId | None = None,
    template_name: Annotated[str, Field(max_length=200)] | None = None,
    create_summary: bool = True,
    extract_memory: bool = True,
    detect_chapters: bool = False,
) -> JobSubmission:
    """Queue selected post-processing jobs for a transcribed recording and
    return immediately. Poll get_job_status instead of holding a tool call open."""
    jobs: list[dict[str, Any]] = []
    with _client() as c:
        if detect_chapters and not c.get_chapters(recording_id):
            job = c.generate_chapters(recording_id)
            jobs.append({"phase": "chapters", "job_id": int(job["job_id"])})
        if extract_memory:
            job = c.extract_action_items(recording_id)
            jobs.append({"phase": "action_items", "job_id": int(job["job_id"])})
        if create_summary:
            summary = _create_summary(
                c,
                recording_id,
                template_id=template_id,
                template_name=template_name,
                wait=False,
            )
            jobs.append(
                {
                    "phase": "summarize",
                    "job_id": int(summary["job_id"]),
                    "summary_id": int(summary["summary_id"]),
                }
            )
    return {
        "recording_id": recording_id,
        "status": "queued" if jobs else "unchanged",
        "jobs": jobs,
        "message": "Status mit get_job_status abrufen.",
    }


@_tool(
    "analysis",
    read_only=False,
    idempotent=False,
    open_world=True,
    profiles=("full",),
)
def analyze_recording(
    recording_id: int,
    template_id: int | None = None,
    template_name: str | None = None,
    create_summary: bool = True,
    extract_action_items: bool = True,
    detect_chapters: bool = False,
    wait: bool = True,
    timeout_sec: float = 900.0,
) -> dict[str, Any]:
    """Run post-processing for an existing recording: optional chapters,
    summary, action-item extraction, then return a full recording context."""
    with _client() as c:
        return _analyze_recording(
            c,
            recording_id,
            template_id=template_id,
            template_name=template_name,
            create_summary=create_summary,
            extract_action_items=extract_action_items,
            detect_chapters=detect_chapters,
            wait=wait,
            timeout_sec=timeout_sec,
        )


@_tool("analysis", read_only=False, idempotent=False, open_world=True)
def create_summary(
    recording_id: PositiveId,
    template_id: PositiveId | None = None,
    template_name: Annotated[str, Field(max_length=200)] | None = None,
    wait: bool = False,
    timeout_sec: Annotated[float, Field(gt=0, le=1800)] = 600.0,
) -> dict[str, Any]:
    """Generate a summary for a transcribed recording, optionally with a specific
    template (by id or name; otherwise a default template is used). Returns a job
    id immediately by default; use get_job_status to poll. Full mode can opt into
    wait=True. Requires the recording to be transcribed first."""
    with _client() as c:
        return _create_summary(
            c,
            recording_id,
            template_id=template_id,
            template_name=template_name,
            wait=wait,
            timeout_sec=timeout_sec,
        )


@_tool(
    "export",
    read_only=False,
    destructive=True,
    idempotent=True,
    profiles=("full",),
)
def export_recording_note(recording_id: PositiveId) -> dict[str, Any]:
    """Export a Markdown meeting note only into the recording topic's configured
    export folder. Arbitrary filesystem destinations are not accepted."""
    with _client() as c:
        return c.export_recording_note(recording_id)


@mcp.resource("tarscribe://recordings/{recording_id}/transcript")
def recording_transcript_resource(recording_id: str) -> str:
    """Transcript JSON for one recording."""
    with _client() as c:
        return json.dumps(c.get_transcript(int(recording_id)), ensure_ascii=False)


@mcp.resource("tarscribe://recordings/{recording_id}/summaries")
def recording_summaries_resource(recording_id: str) -> str:
    """Summary JSON list for one recording."""
    with _client() as c:
        return json.dumps(c.list_summaries(int(recording_id)), ensure_ascii=False)


@mcp.resource("tarscribe://recordings/{recording_id}/action-items")
def recording_action_items_resource(recording_id: str) -> str:
    """Task/decision JSON list for one recording."""
    with _client() as c:
        return json.dumps(c.list_recording_action_items(int(recording_id)), ensure_ascii=False)


@mcp.resource("tarscribe://memory/overview")
def memory_overview_resource() -> str:
    """Compact project-memory overview JSON."""
    with _client() as c:
        return json.dumps(c.get_memory_overview(), ensure_ascii=False)


@mcp.resource("tarscribe://memory/items/{item_id}")
def memory_item_resource(item_id: str) -> str:
    """One source-backed commitment or decision as JSON."""
    with _client() as c:
        return json.dumps(c.get_memory_item(int(item_id)), ensure_ascii=False)


@mcp.resource("tarscribe://people/{speaker_id}")
def person_memory_resource(speaker_id: str) -> str:
    """Compact source-backed memory for one known speaker as JSON."""
    with _client() as c:
        return json.dumps(c.get_people_memory(int(speaker_id)), ensure_ascii=False)


@mcp.resource("tarscribe://threads/{thread_id}")
def thread_resource(thread_id: str) -> str:
    """One recurring topic with its first page of source mentions as JSON."""
    with _client() as c:
        return json.dumps(c.get_thread(int(thread_id)), ensure_ascii=False)


def main() -> None:
    mcp.run()

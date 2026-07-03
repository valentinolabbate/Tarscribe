"""FastMCP tool definitions — thin wrappers over :mod:`client`."""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from .client import BackendClient, discover, process_recording
from .client import analyze_recording as _analyze_recording
from .client import create_summary as _create_summary
from .client import export_summary as _export_summary
from .client import get_recording_context as _get_recording_context

mcp = FastMCP("Tarscribe")


def _client() -> BackendClient:
    """A fresh client bound to the currently running app (cheap; per call)."""
    return BackendClient(discover())


# ── discovery / read ─────────────────────────────────────────────────────────
@mcp.tool()
def list_topics() -> list[dict]:
    """List the topic areas (Themenbereiche). Recordings must belong to one."""
    with _client() as c:
        return c.list_topics()


@mcp.tool()
def create_topic(name: str, color: str | None = None) -> dict:
    """Create a new topic area and return it (use its id for uploads)."""
    with _client() as c:
        return c.create_topic(name, color)


@mcp.tool()
def list_recordings() -> list[dict]:
    """List existing recordings with their status."""
    with _client() as c:
        return c.list_recordings()


@mcp.tool()
def list_known_speakers() -> list[dict]:
    """List enrolled speakers that diarized speakers can be matched against."""
    with _client() as c:
        return c.list_known_speakers()


@mcp.tool()
def get_jobs(recording_id: int) -> list[dict]:
    """Job status (phase/status/progress/error) for a recording."""
    with _client() as c:
        return c.get_jobs(recording_id)


@mcp.tool()
def wait_for_jobs(
    recording_id: int,
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


@mcp.tool()
def get_transcript(recording_id: int) -> dict:
    """Fetch the transcript text + word timings for a recording."""
    with _client() as c:
        return c.get_transcript(recording_id)


@mcp.tool()
def get_diarization(recording_id: int) -> dict:
    """Fetch speaker-attributed utterances + speaker list for a recording."""
    with _client() as c:
        return c.get_diarization(recording_id)


@mcp.tool()
def get_chapters(recording_id: int) -> list[dict]:
    """Fetch detected chapters for a recording."""
    with _client() as c:
        return c.get_chapters(recording_id)


@mcp.tool()
def list_summaries(recording_id: int) -> list[dict]:
    """List generated summaries for a recording, newest first."""
    with _client() as c:
        return c.list_summaries(recording_id)


@mcp.tool()
def list_action_items(
    topic_id: int | None = None,
    recording_id: int | None = None,
    done: bool | None = None,
    mine_only: bool = False,
    include_decisions: bool = True,
) -> list[dict]:
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


@mcp.tool()
def update_action_item(
    item_id: int,
    done: bool | None = None,
    text: str | None = None,
    assignee: str | None = None,
    due: str | None = None,
    due_date: str | None = None,
    include_in_tasks: bool | None = None,
) -> dict:
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


@mcp.tool()
def search_recordings(
    query: str,
    topic_id: int | None = None,
    recording_id: int | None = None,
    include_topic_context: bool = False,
    top_k: int | None = None,
    speaker: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict:
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
            date_from=date_from,
            date_to=date_to,
        )


@mcp.tool()
def get_recording_context(
    recording_id: int,
    include_transcript: bool = True,
    include_diarization: bool = True,
    include_chapters: bool = True,
    include_summaries: bool = True,
    include_action_items: bool = True,
    include_threads: bool = True,
) -> dict:
    """Fetch the complete working context for one recording: metadata, jobs,
    transcript, diarization, chapters, summaries, tasks, and recurring threads."""
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


@mcp.tool()
def list_templates() -> list[dict]:
    """List summary templates. Pass a template's id to create_summary to use it."""
    with _client() as c:
        return c.list_templates()


# ── actions ──────────────────────────────────────────────────────────────────
@mcp.tool()
def upload_recording(file_path: str, topic_id: int, title: str | None = None) -> dict:
    """Upload a local audio file into a topic. Returns the created recording."""
    with _client() as c:
        return c.upload_recording(file_path, topic_id, title)


@mcp.tool()
def start_transcription(recording_id: int, asr_model: str | None = None) -> dict:
    """Queue transcription (ASR). Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.transcribe(recording_id, asr_model)


@mcp.tool()
def start_diarization(recording_id: int) -> dict:
    """Queue speaker diarization. Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.diarize(recording_id)


@mcp.tool()
def start_chapter_detection(recording_id: int) -> dict:
    """Queue automatic chapter detection. Returns the job id to poll with get_jobs."""
    with _client() as c:
        return c.generate_chapters(recording_id)


@mcp.tool()
def match_speakers(recording_id: int) -> dict:
    """Match this recording's diarized speakers against the known-speaker library."""
    with _client() as c:
        return c.match_speakers(recording_id)


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
def create_summary(
    recording_id: int,
    template_id: int | None = None,
    template_name: str | None = None,
    wait: bool = True,
    timeout_sec: float = 600.0,
) -> dict[str, Any]:
    """Generate a summary for a transcribed recording, optionally with a specific
    template (by id or name; otherwise a default template is used). Blocks until
    the summary is ready and returns its content and the topic sources it drew on;
    pass wait=False to return immediately with a job id to poll via get_jobs.
    Requires the recording to be transcribed first."""
    with _client() as c:
        return _create_summary(
            c,
            recording_id,
            template_id=template_id,
            template_name=template_name,
            wait=wait,
            timeout_sec=timeout_sec,
        )


@mcp.tool()
def export_summary(summary_id: int, file_path: str) -> dict[str, Any]:
    """Write a summary's Markdown content to a local file at file_path (parent
    folders are created). Use create_summary first to obtain the summary_id."""
    with _client() as c:
        return _export_summary(c, summary_id, file_path)


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


def main() -> None:
    mcp.run()

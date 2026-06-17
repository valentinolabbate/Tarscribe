"""FastMCP tool definitions — thin wrappers over :mod:`client`."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from .client import BackendClient, discover, process_recording

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
    timeout_sec: float = 1800.0,
) -> dict[str, Any]:
    """End-to-end: upload → transcribe → chapters → (diarize → match speakers),
    blocking until done. Returns transcript text, chapters, speakers and
    utterances. Use this for one-shot autonomous processing of a single audio
    file."""
    with _client() as c:
        return process_recording(
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


def main() -> None:
    mcp.run()

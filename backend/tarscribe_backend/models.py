"""SQLModel tables backing the Tarscribe app.

The schema is designed around the staged transcription/diarization pipeline:

  * ``Transcript``/``Word``      -> Stage A (ASR), expensive, cached.
  * ``DiarizationRun``/``Segment`` -> Stage B, re-runnable with parameters.
  * Alignment (Stage C) is derived on the fly from words + active run.
  * ``ManualEdit``               -> Stage D, persistent user corrections overlay.

See the project plan for the full rationale.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RecordingStatus(str, Enum):
    uploaded = "uploaded"
    queued = "queued"
    transcribing = "transcribing"
    diarizing = "diarizing"
    ready = "ready"
    failed = "failed"


class LiveSessionStatus(str, Enum):
    starting = "starting"
    recording = "recording"
    paused = "paused"
    finalizing = "finalizing"
    completed = "completed"
    failed = "failed"
    canceled = "canceled"


class JobPhase(str, Enum):
    asr = "asr"
    diarization = "diarization"
    alignment = "alignment"
    summarize = "summarize"
    embedding = "embedding"
    action_items = "action_items"
    chapters = "chapters"
    digest = "digest"
    threads = "threads"


class JobStatus(str, Enum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"
    canceled = "canceled"


class Topic(SQLModel, table=True):
    __tablename__ = "topics"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    color: str = "#6366f1"
    # Default folder to send Markdown exports to (e.g. an Obsidian vault folder).
    export_path: Optional[str] = None
    # off | approval | auto: whether dated tasks in this topic sync to CalDAV.
    calendar_export_mode: str = "off"
    # Optional per-topic CalDAV collection URL; falls back to the global setting.
    calendar_url: Optional[str] = None
    # User-defined sort order in the sidebar (ascending). Ties fall back to created_at.
    position: int = Field(default=0, index=True)
    created_at: datetime = Field(default_factory=_utcnow)


class Recording(SQLModel, table=True):
    __tablename__ = "recordings"

    id: Optional[int] = Field(default=None, primary_key=True)
    topic_id: int = Field(foreign_key="topics.id", index=True)
    title: str
    # Path to the normalized 16kHz mono wav stored in the app data dir.
    audio_path: str
    # Original uploaded filename, for display/export.
    original_filename: Optional[str] = None
    duration_sec: float = 0.0
    sample_rate: int = 16000
    language: Optional[str] = None
    kind: str = "recording"  # recording | dictation
    status: RecordingStatus = RecordingStatus.uploaded
    exported_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_utcnow)


class Transcript(SQLModel, table=True):
    """Stage A artifact. One active transcript per recording (cached ASR output)."""

    __tablename__ = "transcripts"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    asr_model: str
    language: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class Word(SQLModel, table=True):
    __tablename__ = "words"

    id: Optional[int] = Field(default=None, primary_key=True)
    transcript_id: int = Field(foreign_key="transcripts.id", ondelete="CASCADE", index=True)
    idx: int  # ordering within the transcript
    start: float
    end: float
    text: str
    confidence: Optional[float] = None


class DiarizationRun(SQLModel, table=True):
    """Stage B artifact. Versioned: changing tuning params creates a new run."""

    __tablename__ = "diarization_runs"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    model: str
    params_json: str = "{}"  # serialized diarization parameters
    num_speakers: Optional[int] = None
    is_active: bool = True
    created_at: datetime = Field(default_factory=_utcnow)


class Segment(SQLModel, table=True):
    __tablename__ = "speaker_segments"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="diarization_runs.id", ondelete="CASCADE", index=True)
    start: float
    end: float
    speaker_label: str  # raw label from the pipeline, e.g. "SPEAKER_00"


class SpeakerLabel(SQLModel, table=True):
    """Maps a raw diarization label to a display name / known speaker, per recording."""

    __tablename__ = "speaker_labels"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    original_label: str
    display_name: Optional[str] = None
    known_speaker_id: Optional[int] = Field(
        default=None, foreign_key="known_speakers.id", ondelete="SET NULL"
    )


class KnownSpeaker(SQLModel, table=True):
    """Global voiceprint library entry."""

    __tablename__ = "known_speakers"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    color: str = "#10b981"
    photo_path: Optional[str] = None
    # Mean speaker embedding, stored as raw float32 bytes.
    embedding_blob: Optional[bytes] = None
    sample_count: int = 0
    created_at: datetime = Field(default_factory=_utcnow)


class ManualEdit(SQLModel, table=True):
    """Stage D overlay. Survives re-runs of stages B/C."""

    __tablename__ = "manual_edits"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    edit_type: str  # rename | reassign | merge | split | boundary
    payload_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)


class SummaryTemplate(SQLModel, table=True):
    __tablename__ = "summary_templates"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    system_prompt: str = ""
    user_prompt_template: str = ""
    output_format: str = "markdown"  # markdown | text
    model_override: Optional[str] = None
    is_builtin: bool = False
    created_at: datetime = Field(default_factory=_utcnow)


class Summary(SQLModel, table=True):
    __tablename__ = "summaries"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    template_id: Optional[int] = Field(default=None, foreign_key="summary_templates.id")
    model: str
    content: str = ""
    generated_content: Optional[str] = None
    revision: int = 0
    updated_at: datetime = Field(default_factory=_utcnow)
    # JSON-encoded list of topic-knowledge passages woven into this summary
    # (see jobs._run_summary). None when no extra knowledge was used.
    sources: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class Document(SQLModel, table=True):
    """An uploaded reference document attached to a topic or a single recording.

    Its extracted text is chunked and embedded into the same RAG index as
    transcripts/summaries, so it surfaces in search and the knowledge chat.
    ``recording_id`` is set for recording-scoped documents, ``None`` for
    topic-level ones.
    """

    __tablename__ = "documents"

    id: Optional[int] = Field(default=None, primary_key=True)
    topic_id: int = Field(foreign_key="topics.id", ondelete="CASCADE", index=True)
    recording_id: Optional[int] = Field(
        default=None, foreign_key="recordings.id", ondelete="CASCADE", index=True
    )
    title: str
    original_filename: Optional[str] = None
    source_kind: str = Field(default="upload", index=True)
    source_url: Optional[str] = None
    crawl_pages: int = 0
    # Stored copy of the original upload in the app's documents dir.
    file_path: str
    content_type: Optional[str] = None
    # Length of the extracted plain text (for display; 0 until indexed).
    text_chars: int = 0
    content: Optional[str] = None
    revision: int = 0
    status: str = "uploaded"  # uploaded | indexing | ready | failed
    error: Optional[str] = None
    updated_at: datetime = Field(default_factory=_utcnow)
    created_at: datetime = Field(default_factory=_utcnow)


class RagChunk(SQLModel, table=True):
    """A retrievable passage of a transcript or summary, embedded for RAG search.

    The embedding vector itself lives in the ``rag_chunk_vec`` sqlite-vec virtual
    table (keyed by this row's ``id``); this table holds the text + metadata.
    """

    __tablename__ = "rag_chunks"

    id: Optional[int] = Field(default=None, primary_key=True)
    # Nullable: document chunks attached to a *topic* (not a recording) have no
    # recording_id. Recording-scoped chunks (transcript/summary/recording-document)
    # carry it so recording-filtered retrieval includes them.
    recording_id: Optional[int] = Field(
        default=None, foreign_key="recordings.id", ondelete="CASCADE", index=True
    )
    # Denormalized for fast topic-filtered KNN (mirrored into the vec0 table).
    topic_id: int = Field(index=True)
    summary_id: Optional[int] = Field(default=None, foreign_key="summaries.id", ondelete="CASCADE")
    document_id: Optional[int] = Field(
        default=None, foreign_key="documents.id", ondelete="CASCADE", index=True
    )
    source_type: str = "transcript"  # transcript | summary | document
    chunk_index: int = 0
    text: str = ""
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None
    speaker: Optional[str] = None
    # Hash of the source text; lets re-indexing skip unchanged content.
    content_hash: str = ""
    embed_model: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ChatSession(SQLModel, table=True):
    """A persisted AI-chat thread, scoped globally or to one recording."""

    __tablename__ = "chat_sessions"

    id: Optional[int] = Field(default=None, primary_key=True)
    scope: str = Field(index=True)  # global | recording
    title: str = "Neuer Chat"
    recording_id: Optional[int] = Field(
        default=None, foreign_key="recordings.id", ondelete="CASCADE", index=True
    )
    topic_id: Optional[int] = Field(
        default=None, foreign_key="topics.id", ondelete="SET NULL", index=True
    )
    archived: bool = False
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow, index=True)


class ChatMessage(SQLModel, table=True):
    """One stored chat turn. Assistant messages keep their source and tool snapshots."""

    __tablename__ = "chat_messages"

    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: int = Field(foreign_key="chat_sessions.id", ondelete="CASCADE", index=True)
    role: str
    content: str = ""
    sources_json: Optional[str] = None
    agent_research_json: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class ActionItem(SQLModel, table=True):
    """An LLM-extracted task or decision from one recording, checkable by the user."""

    __tablename__ = "action_items"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    kind: str = "task"  # task | decision
    text: str
    assignee: Optional[str] = None
    due: Optional[str] = None  # free-text deadline as spoken ("bis Freitag")
    due_date: Optional[str] = None  # user-set ISO date (YYYY-MM-DD) for filtering/calendar export
    recipient: Optional[str] = None
    source_quote: Optional[str] = None
    source_start_sec: Optional[float] = None
    confidence: float = 0.5
    review_state: str = "pending"  # pending | confirmed | rejected
    decision_status: str = "current"  # proposed | current | superseded | rejected
    superseded_by_id: Optional[int] = Field(
        default=None, foreign_key="action_items.id", ondelete="SET NULL", index=True
    )
    enrichment_state: str = "complete"  # pending | complete | enriched | no_match
    enriched_at: Optional[datetime] = None
    done: bool = False
    # User opt-in to surface a not-"mine" item in the global Tasks area (which by
    # default only shows items assigned to the configured "me" speaker).
    include_in_tasks: bool = False
    calendar_uid: Optional[str] = None
    calendar_href: Optional[str] = None
    calendar_etag: Optional[str] = None
    calendar_status: str = "idle"  # idle | pending_approval | synced | skipped | failed | not_configured
    calendar_error: Optional[str] = None
    calendar_exported_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow, index=True)


class MemoryEnrichmentRun(SQLModel, table=True):
    __tablename__ = "memory_enrichment_runs"

    id: Optional[int] = Field(default=None, primary_key=True)
    status: str = "pending"  # pending | running | done | partial | failed
    total_recordings: int = 0
    processed_recordings: int = 0
    total_items: int = 0
    enriched_items: int = 0
    unmatched_items: int = 0
    failed_recordings: int = 0
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow, index=True)


class Chapter(SQLModel, table=True):
    """An LLM-detected topic chapter within a recording."""

    __tablename__ = "chapters"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    idx: int = 0
    start: float = 0.0
    end: Optional[float] = None
    title: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class TopicThread(SQLModel, table=True):
    """A recurring discussion thread detected across recordings."""

    __tablename__ = "threads"

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str
    updated_at: datetime = Field(default_factory=_utcnow, index=True)
    created_at: datetime = Field(default_factory=_utcnow)


class ThreadMention(SQLModel, table=True):
    """One recording/chapter/chunk occurrence belonging to a recurring thread."""

    __tablename__ = "thread_mentions"

    id: Optional[int] = Field(default=None, primary_key=True)
    thread_id: int = Field(foreign_key="threads.id", ondelete="CASCADE", index=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    chapter_id: Optional[int] = Field(default=None, foreign_key="chapters.id", ondelete="SET NULL")
    chunk_id: Optional[int] = Field(default=None, foreign_key="rag_chunks.id", ondelete="SET NULL")
    start_sec: Optional[float] = None
    text: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class Digest(SQLModel, table=True):
    """A cross-recording weekly digest generated from existing insights."""

    __tablename__ = "digests"

    id: Optional[int] = Field(default=None, primary_key=True)
    date_from: datetime = Field(index=True)
    date_to: datetime = Field(index=True)
    content_markdown: str = ""
    model: str = ""
    recording_count: int = 0
    created_at: datetime = Field(default_factory=_utcnow)


class Job(SQLModel, table=True):
    __tablename__ = "jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", ondelete="CASCADE", index=True)
    phase: JobPhase
    progress: float = 0.0  # 0..1
    status: JobStatus = JobStatus.pending
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class LiveRecordingSession(SQLModel, table=True):
    """Tracks a live recording session from microphone capture to finalization."""

    __tablename__ = "live_recording_sessions"

    id: str = Field(primary_key=True)  # UUID hex
    topic_id: int = Field(foreign_key="topics.id", ondelete="CASCADE", index=True)
    title: str
    status: LiveSessionStatus = LiveSessionStatus.starting
    pcm_path: Optional[str] = None
    sample_rate: int = 16000
    channels: int = 1
    last_sequence_number: int = -1  # highest confirmed chunk index
    received_duration_sec: float = 0.0
    transcript_snapshot_json: Optional[str] = None
    speaker_snapshot_json: Optional[str] = None
    last_analyzed_sec: float = 0.0
    finalized_recording_id: Optional[int] = Field(
        default=None, foreign_key="recordings.id", ondelete="CASCADE"
    )
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

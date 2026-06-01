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
    status: RecordingStatus = RecordingStatus.uploaded
    created_at: datetime = Field(default_factory=_utcnow)


class Transcript(SQLModel, table=True):
    """Stage A artifact. One active transcript per recording (cached ASR output)."""

    __tablename__ = "transcripts"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", index=True)
    asr_model: str
    language: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class Word(SQLModel, table=True):
    __tablename__ = "words"

    id: Optional[int] = Field(default=None, primary_key=True)
    transcript_id: int = Field(foreign_key="transcripts.id", index=True)
    idx: int  # ordering within the transcript
    start: float
    end: float
    text: str
    confidence: Optional[float] = None


class DiarizationRun(SQLModel, table=True):
    """Stage B artifact. Versioned: changing tuning params creates a new run."""

    __tablename__ = "diarization_runs"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", index=True)
    model: str
    params_json: str = "{}"  # serialized diarization parameters
    num_speakers: Optional[int] = None
    is_active: bool = True
    created_at: datetime = Field(default_factory=_utcnow)


class Segment(SQLModel, table=True):
    __tablename__ = "speaker_segments"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="diarization_runs.id", index=True)
    start: float
    end: float
    speaker_label: str  # raw label from the pipeline, e.g. "SPEAKER_00"


class SpeakerLabel(SQLModel, table=True):
    """Maps a raw diarization label to a display name / known speaker, per recording."""

    __tablename__ = "speaker_labels"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", index=True)
    original_label: str
    display_name: Optional[str] = None
    known_speaker_id: Optional[int] = Field(default=None, foreign_key="known_speakers.id")


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
    recording_id: int = Field(foreign_key="recordings.id", index=True)
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
    recording_id: int = Field(foreign_key="recordings.id", index=True)
    template_id: Optional[int] = Field(default=None, foreign_key="summary_templates.id")
    model: str
    content: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class Job(SQLModel, table=True):
    __tablename__ = "jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    recording_id: int = Field(foreign_key="recordings.id", index=True)
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
    topic_id: int = Field(foreign_key="topics.id", index=True)
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
    finalized_recording_id: Optional[int] = Field(default=None, foreign_key="recordings.id")
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

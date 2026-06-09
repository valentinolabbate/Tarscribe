"""Request/response payloads for the HTTP API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class TopicCreate(BaseModel):
    name: str
    color: str = "#6366f1"


class TopicUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    export_path: str | None = None


class TopicOverview(BaseModel):
    id: int
    name: str
    color: str
    export_path: str | None = None
    created_at: datetime
    recording_count: int = 0
    transcribed_count: int = 0
    diarized_count: int = 0
    exported_count: int = 0


class RecordingCreate(BaseModel):
    topic_id: int
    title: str | None = None


class RecordingUpdate(BaseModel):
    title: str | None = None
    topic_id: int | None = None


class LiveSessionCreate(BaseModel):
    topic_id: int
    title: str = "Live-Aufnahme"


class LiveSessionFinish(BaseModel):
    recording_id: int | None = None

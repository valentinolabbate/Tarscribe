"""CRUD for topic areas (Themenbereiche)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlmodel import Session, select

from ..calendar_sync import CALENDAR_MODES, sync_topic_action_items
from ..db import get_session, vec_available
from ..models import DiarizationRun, Document, Recording, Topic, Transcript
from ..schemas import TopicCreate, TopicOverview, TopicReorder, TopicUpdate

router = APIRouter(prefix="/api/topics", tags=["topics"])


@router.get("")
def list_topics(session: Session = Depends(get_session)) -> list[TopicOverview]:
    topics = list(session.exec(select(Topic).order_by(Topic.position, Topic.created_at)).all())
    recordings = list(session.exec(select(Recording)).all())
    transcript_ids = set(session.exec(select(Transcript.recording_id).distinct()).all())
    diarized_ids = set(
        session.exec(
            select(DiarizationRun.recording_id)
            .where(DiarizationRun.is_active == True)  # noqa: E712
            .distinct()
        ).all()
    )

    by_topic: dict[int, list[Recording]] = {}
    for rec in recordings:
        by_topic.setdefault(rec.topic_id, []).append(rec)

    result: list[TopicOverview] = []
    for topic in topics:
        rows = by_topic.get(topic.id or 0, [])
        result.append(
            TopicOverview(
                id=topic.id or 0,
                name=topic.name,
                color=topic.color,
                export_path=topic.export_path,
                calendar_export_mode=topic.calendar_export_mode,
                calendar_url=topic.calendar_url,
                position=topic.position,
                created_at=topic.created_at,
                recording_count=len(rows),
                transcribed_count=sum(1 for rec in rows if rec.id in transcript_ids),
                diarized_count=sum(1 for rec in rows if rec.id in diarized_ids),
                exported_count=sum(1 for rec in rows if rec.exported_at is not None),
            )
        )
    return result


@router.post("", status_code=201)
def create_topic(payload: TopicCreate, session: Session = Depends(get_session)) -> Topic:
    max_position = session.exec(select(func.max(Topic.position))).one()
    topic = Topic(
        name=payload.name.strip() or "Unbenannt",
        color=payload.color,
        position=0 if max_position is None else max_position + 1,
    )
    session.add(topic)
    session.commit()
    session.refresh(topic)
    return topic


@router.post("/reorder", status_code=204)
def reorder_topics(payload: TopicReorder, session: Session = Depends(get_session)) -> None:
    """Persist the sidebar arrangement. `order` lists topic ids top-to-bottom.

    Ids missing from the payload keep their relative order after the listed ones,
    so a partial list still produces a deterministic result.
    """
    topics = list(session.exec(select(Topic).order_by(Topic.position, Topic.created_at)).all())
    rank = {topic_id: idx for idx, topic_id in enumerate(payload.order)}
    fallback = len(payload.order)
    ordered = sorted(
        topics,
        key=lambda topic: (rank.get(topic.id or 0, fallback), topic.position, topic.id or 0),
    )
    for position, topic in enumerate(ordered):
        if topic.position != position:
            topic.position = position
            session.add(topic)
    session.commit()


@router.patch("/{topic_id}")
def update_topic(
    topic_id: int, payload: TopicUpdate, session: Session = Depends(get_session)
) -> Topic:
    topic = session.get(Topic, topic_id)
    if not topic:
        raise HTTPException(404, "Themenbereich nicht gefunden")
    if payload.name is not None:
        topic.name = payload.name
    if payload.color is not None:
        topic.color = payload.color
    if payload.export_path is not None:
        topic.export_path = payload.export_path.strip() or None
    sync_needed = False
    if payload.calendar_export_mode is not None:
        mode = payload.calendar_export_mode.strip()
        if mode not in CALENDAR_MODES:
            raise HTTPException(400, "Ungültiger Kalender-Modus")
        topic.calendar_export_mode = mode
        sync_needed = True
    if payload.calendar_url is not None:
        topic.calendar_url = payload.calendar_url.strip() or None
        sync_needed = True
    session.add(topic)
    if sync_needed:
        sync_topic_action_items(session, topic_id)
    session.commit()
    session.refresh(topic)
    return topic


@router.delete("/{topic_id}", status_code=204)
def delete_topic(topic_id: int, session: Session = Depends(get_session)) -> None:
    topic = session.get(Topic, topic_id)
    if not topic:
        raise HTTPException(404, "Themenbereich nicht gefunden")
    has_recordings = session.exec(
        select(Recording).where(Recording.topic_id == topic_id).limit(1)
    ).first()
    if has_recordings:
        raise HTTPException(
            409, "Themenbereich enthält noch Aufnahmen und kann nicht gelöscht werden."
        )

    from .documents import _stored_paths_for_delete

    doc_files = []
    docs = session.exec(select(Document).where(Document.topic_id == topic_id)).all()
    if docs and vec_available():
        from .. import rag

        for doc in docs:
            rag._delete_document_chunks(session, doc.id)
    for doc in docs:
        doc_files.extend(_stored_paths_for_delete(doc))

    session.delete(topic)
    session.commit()
    for doc_file in doc_files:
        try:
            doc_file.unlink(missing_ok=True)
        except OSError as exc:
            print(f"Dokumentdatei konnte nach DB-Löschung nicht entfernt werden: {exc}")

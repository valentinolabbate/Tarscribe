"""CRUD for topic areas (Themenbereiche)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import Recording, Topic
from ..schemas import TopicCreate, TopicUpdate
from ..security import require_token

router = APIRouter(prefix="/api/topics", tags=["topics"], dependencies=[Depends(require_token)])


@router.get("")
def list_topics(session: Session = Depends(get_session)) -> list[Topic]:
    return list(session.exec(select(Topic).order_by(Topic.created_at)).all())


@router.post("", status_code=201)
def create_topic(payload: TopicCreate, session: Session = Depends(get_session)) -> Topic:
    topic = Topic(name=payload.name.strip() or "Unbenannt", color=payload.color)
    session.add(topic)
    session.commit()
    session.refresh(topic)
    return topic


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
    session.add(topic)
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
    session.delete(topic)
    session.commit()

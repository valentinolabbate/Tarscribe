"""Persisted AI chat sessions and message history."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import ChatMessage, ChatSession, Recording, Topic

router = APIRouter(prefix="/api/chats", tags=["chats"])

VALID_SCOPES = {"global", "recording"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ChatSessionCreate(BaseModel):
    scope: str = "global"
    title: str | None = None
    recording_id: int | None = None
    topic_id: int | None = None


class ChatSessionPatch(BaseModel):
    title: str | None = None
    archived: bool | None = None


class ChatMessageIn(BaseModel):
    role: str
    content: str
    sources: list[dict] | None = None


def _title_from_text(text: str) -> str:
    title = " ".join(text.strip().split())
    if not title:
        return "Neuer Chat"
    return title[:57] + "..." if len(title) > 60 else title


def _validate_scope(
    payload: ChatSessionCreate,
    session: Session,
) -> tuple[str, int | None, int | None]:
    scope = payload.scope.strip().lower()
    if scope not in VALID_SCOPES:
        raise HTTPException(400, "Unbekannter Chat-Scope.")

    recording_id = payload.recording_id
    topic_id = payload.topic_id
    if scope == "recording":
        if recording_id is None:
            raise HTTPException(400, "Recording-Chats benötigen eine Aufnahme.")
        rec = session.get(Recording, recording_id)
        if not rec:
            raise HTTPException(404, "Aufnahme nicht gefunden")
        topic_id = topic_id if topic_id is not None else rec.topic_id
    elif recording_id is not None:
        raise HTTPException(400, "Globale Chats dürfen keine Aufnahme referenzieren.")

    if topic_id is not None and not session.get(Topic, topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")
    return scope, recording_id, topic_id


def _message_dict(msg: ChatMessage) -> dict:
    sources = None
    if msg.sources_json:
        try:
            sources = json.loads(msg.sources_json)
        except json.JSONDecodeError:
            sources = None
    return {
        "id": msg.id,
        "session_id": msg.session_id,
        "role": msg.role,
        "content": msg.content,
        "sources": sources,
        "created_at": msg.created_at.isoformat(),
    }


def _session_dict(chat: ChatSession, session: Session, include_messages: bool = False) -> dict:
    messages = session.exec(
        select(ChatMessage)
        .where(ChatMessage.session_id == chat.id)
        .order_by(ChatMessage.created_at, ChatMessage.id)
    ).all()
    data = {
        "id": chat.id,
        "scope": chat.scope,
        "title": chat.title,
        "recording_id": chat.recording_id,
        "topic_id": chat.topic_id,
        "archived": chat.archived,
        "message_count": len(messages),
        "created_at": chat.created_at.isoformat(),
        "updated_at": chat.updated_at.isoformat(),
    }
    if include_messages:
        data["messages"] = [_message_dict(m) for m in messages]
    return data


def _get_chat(chat_id: int, session: Session) -> ChatSession:
    chat = session.get(ChatSession, chat_id)
    if not chat:
        raise HTTPException(404, "Chat nicht gefunden")
    return chat


@router.get("")
def list_chats(
    scope: str | None = None,
    recording_id: int | None = None,
    topic_id: int | None = None,
    include_archived: bool = False,
    session: Session = Depends(get_session),
) -> list[dict]:
    stmt = select(ChatSession)
    if scope:
        normalized = scope.strip().lower()
        if normalized not in VALID_SCOPES:
            raise HTTPException(400, "Unbekannter Chat-Scope.")
        stmt = stmt.where(ChatSession.scope == normalized)
    if recording_id is not None:
        stmt = stmt.where(ChatSession.recording_id == recording_id)
    if topic_id is not None:
        stmt = stmt.where(ChatSession.topic_id == topic_id)
    if not include_archived:
        stmt = stmt.where(ChatSession.archived == False)  # noqa: E712
    chats = session.exec(stmt.order_by(ChatSession.updated_at.desc())).all()
    return [_session_dict(chat, session) for chat in chats]


@router.post("", status_code=201)
def create_chat(payload: ChatSessionCreate, session: Session = Depends(get_session)) -> dict:
    scope, recording_id, topic_id = _validate_scope(payload, session)
    chat = ChatSession(
        scope=scope,
        recording_id=recording_id,
        topic_id=topic_id,
        title=(payload.title or "").strip() or "Neuer Chat",
    )
    session.add(chat)
    session.commit()
    session.refresh(chat)
    return _session_dict(chat, session, include_messages=True)


@router.get("/{chat_id}")
def get_chat(chat_id: int, session: Session = Depends(get_session)) -> dict:
    return _session_dict(_get_chat(chat_id, session), session, include_messages=True)


@router.patch("/{chat_id}")
def update_chat(
    chat_id: int,
    payload: ChatSessionPatch,
    session: Session = Depends(get_session),
) -> dict:
    chat = _get_chat(chat_id, session)
    if payload.title is not None:
        chat.title = payload.title.strip() or "Neuer Chat"
    if payload.archived is not None:
        chat.archived = payload.archived
    chat.updated_at = _utcnow()
    session.add(chat)
    session.commit()
    session.refresh(chat)
    return _session_dict(chat, session)


@router.delete("/{chat_id}", status_code=204)
def delete_chat(chat_id: int, session: Session = Depends(get_session)) -> Response:
    chat = _get_chat(chat_id, session)
    messages = session.exec(select(ChatMessage).where(ChatMessage.session_id == chat.id)).all()
    for msg in messages:
        session.delete(msg)
    session.delete(chat)
    session.commit()
    return Response(status_code=204)


@router.post("/{chat_id}/messages", status_code=201)
def append_message(
    chat_id: int,
    payload: ChatMessageIn,
    session: Session = Depends(get_session),
) -> dict:
    chat = _get_chat(chat_id, session)
    role = payload.role.strip().lower()
    if role not in {"user", "assistant", "system"}:
        raise HTTPException(400, "Unbekannte Chat-Rolle.")
    sources_json = json.dumps(payload.sources, ensure_ascii=False) if payload.sources is not None else None
    msg = ChatMessage(
        session_id=chat.id,
        role=role,
        content=payload.content,
        sources_json=sources_json,
    )
    if chat.title == "Neuer Chat" and role == "user":
        chat.title = _title_from_text(payload.content)
    chat.updated_at = _utcnow()
    session.add(chat)
    session.add(msg)
    session.commit()
    session.refresh(msg)
    return _message_dict(msg)

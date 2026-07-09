"""Upload, listing, download, and deletion of reference documents.

Documents attach to a topic (Themenbereich) or a single recording. Their text
is extracted and embedded into the shared RAG index (see ``rag.index_document``)
so they surface in semantic/keyword search and the knowledge chat.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session, vec_available
from ..documents import DocumentError, SUPPORTED_SUFFIXES, extract_text, is_supported
from ..models import Document, Recording, Topic
from ..upload_security import (
    UploadPathForbidden,
    UploadValidationError,
    display_filename,
    require_child_path,
    require_suffix,
)

router = APIRouter(prefix="/api/documents", tags=["documents"])


class DocumentUpdateIn(BaseModel):
    content: str = Field(max_length=2_000_000)
    revision: int = Field(ge=0)


def _document_payload(doc: Document) -> dict:
    return {
        "id": doc.id,
        "topic_id": doc.topic_id,
        "recording_id": doc.recording_id,
        "title": doc.title,
        "original_filename": doc.original_filename,
        "file_path": doc.file_path,
        "content_type": doc.content_type,
        "text_chars": doc.text_chars,
        "revision": doc.revision,
        "status": doc.status,
        "error": doc.error,
        "updated_at": doc.updated_at,
        "created_at": doc.created_at,
    }


def _document_content(doc: Document) -> str:
    if doc.content is not None:
        return doc.content
    try:
        return extract_text(_download_path(doc), doc.content_type)
    except DocumentError:
        return ""


@router.get("")
def list_documents(
    topic_id: int | None = None,
    recording_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """List documents. ``recording_id`` → that recording's docs; ``topic_id`` →
    the topic's *topic-level* docs (those not bound to a recording)."""
    stmt = select(Document).order_by(Document.created_at.desc())
    if recording_id is not None:
        stmt = stmt.where(Document.recording_id == recording_id)
    elif topic_id is not None:
        stmt = stmt.where(
            Document.topic_id == topic_id,
            Document.recording_id == None,  # noqa: E711
        )
    return [_document_payload(doc) for doc in session.exec(stmt).all()]


@router.get("/{document_id}")
def get_document(document_id: int, session: Session = Depends(get_session)) -> dict:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    return _document_payload(doc)


@router.get("/{document_id}/content")
def get_document_content(
    document_id: int, session: Session = Depends(get_session)
) -> dict:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    return {**_document_payload(doc), "content": _document_content(doc)}


@router.patch("/{document_id}")
def update_document(
    document_id: int,
    payload: DocumentUpdateIn,
    session: Session = Depends(get_session),
) -> dict:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    if payload.revision != (doc.revision or 0):
        raise HTTPException(409, "Dokument wurde inzwischen geändert. Bitte neu öffnen.")

    from .. import rag

    should_index = rag.rag_enabled()
    doc.content = payload.content
    doc.text_chars = len(payload.content.strip())
    doc.revision = (doc.revision or 0) + 1
    doc.updated_at = datetime.now(timezone.utc)
    if should_index:
        doc.status = "uploaded"
        doc.error = None
    session.add(doc)
    session.commit()
    session.refresh(doc)

    if should_index:
        from ..jobs import enqueue_document_embedding

        enqueue_document_embedding(document_id)

    return {**_document_payload(doc), "content": doc.content or ""}


@router.post("", status_code=201)
async def upload_document(
    topic_id: int = Form(...),
    recording_id: int | None = Form(None),
    title: str | None = Form(None),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> dict:
    if not session.get(Topic, topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")
    if recording_id is not None:
        rec = session.get(Recording, recording_id)
        if not rec:
            raise HTTPException(404, "Aufnahme nicht gefunden")
        # Keep topic_id consistent with the recording it is attached to.
        topic_id = rec.topic_id

    filename = display_filename(file.filename, "dokument.txt")
    if not is_supported(filename):
        raise HTTPException(
            400,
            "Nicht unterstütztes Format. Erlaubt: "
            + ", ".join(sorted(SUPPORTED_SUFFIXES)),
        )

    try:
        suffix = require_suffix(filename, SUPPORTED_SUFFIXES, "Dokument")
    except UploadValidationError as exc:
        raise HTTPException(400, str(exc)) from exc

    doc = Document(
        topic_id=topic_id,
        recording_id=recording_id,
        title=(title or "").strip() or Path(filename).stem,
        original_filename=filename,
        file_path="",
        content_type=file.content_type,
        status="uploaded",
    )
    session.add(doc)
    session.flush()
    dst = _stored_document_path(doc, suffix)
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    doc.file_path = str(dst)
    session.add(doc)
    session.commit()
    session.refresh(doc)

    from ..jobs import enqueue_document_embedding

    enqueue_document_embedding(doc.id)
    return _document_payload(doc)


@router.post("/{document_id}/reindex")
def reindex_document(
    document_id: int, session: Session = Depends(get_session)
) -> dict:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    from ..jobs import enqueue_document_embedding

    enqueued = enqueue_document_embedding(document_id)
    if enqueued is None:
        raise HTTPException(400, "RAG ist deaktiviert oder sqlite-vec nicht verfügbar.")
    return {"enqueued": True}


@router.get("/{document_id}/file")
def download_document(
    document_id: int, session: Session = Depends(get_session)
) -> FileResponse:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    path = _download_path(doc)
    if not path.exists():
        raise HTTPException(410, "Datei nicht mehr vorhanden")
    return FileResponse(
        path,
        media_type=doc.content_type or "application/octet-stream",
        filename=doc.original_filename or path.name,
    )


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: int, session: Session = Depends(get_session)) -> None:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")

    if vec_available():
        from .. import rag

        rag._delete_document_chunks(session, document_id)

    file_paths = _stored_paths_for_delete(doc)
    session.delete(doc)
    session.commit()
    for file_path in file_paths:
        try:
            file_path.unlink(missing_ok=True)
        except OSError as exc:
            print(f"Dokumentdatei konnte nach DB-Löschung nicht entfernt werden: {exc}")


def _stored_document_path(doc: Document, suffix: str) -> Path:
    if doc.id is None:
        raise HTTPException(500, "Dokument-ID fehlt")
    return get_settings().documents_dir / f"{doc.id}{suffix}"


def _download_path(doc: Document) -> Path:
    suffix = Path(doc.original_filename or doc.file_path).suffix.lower()
    if suffix in SUPPORTED_SUFFIXES and doc.id is not None:
        return _stored_document_path(doc, suffix)
    legacy = Path(doc.file_path)
    try:
        return require_child_path(legacy, get_settings().documents_dir)
    except UploadPathForbidden as exc:
        raise HTTPException(410, "Datei nicht mehr vorhanden") from exc


def _stored_paths_for_delete(doc: Document) -> list[Path]:
    paths: list[Path] = []
    suffix = Path(doc.original_filename or doc.file_path).suffix.lower()
    if suffix in SUPPORTED_SUFFIXES and doc.id is not None:
        paths.append(_stored_document_path(doc, suffix))
    try:
        legacy = require_child_path(Path(doc.file_path), get_settings().documents_dir)
    except UploadPathForbidden:
        legacy = None
    if legacy is not None and legacy not in paths:
        paths.append(legacy)
    return paths

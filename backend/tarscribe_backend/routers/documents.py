"""Upload, listing, download, and deletion of reference documents.

Documents attach to a topic (Themenbereich) or a single recording. Their text
is extracted and embedded into the shared RAG index (see ``rag.index_document``)
so they surface in semantic/keyword search and the knowledge chat.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session, vec_available
from ..documents import SUPPORTED_SUFFIXES, is_supported
from ..models import Document, Recording, Topic
from ..security import require_token

router = APIRouter(
    prefix="/api/documents", tags=["documents"], dependencies=[Depends(require_token)]
)


@router.get("")
def list_documents(
    topic_id: int | None = None,
    recording_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[Document]:
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
    return list(session.exec(stmt).all())


@router.get("/{document_id}")
def get_document(document_id: int, session: Session = Depends(get_session)) -> Document:
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Dokument nicht gefunden")
    return doc


@router.post("", status_code=201)
async def upload_document(
    topic_id: int = Form(...),
    recording_id: int | None = Form(None),
    title: str | None = Form(None),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> Document:
    if not session.get(Topic, topic_id):
        raise HTTPException(404, "Themenbereich nicht gefunden")
    if recording_id is not None:
        rec = session.get(Recording, recording_id)
        if not rec:
            raise HTTPException(404, "Aufnahme nicht gefunden")
        # Keep topic_id consistent with the recording it is attached to.
        topic_id = rec.topic_id

    filename = file.filename or "dokument"
    if not is_supported(filename):
        raise HTTPException(
            415,
            "Nicht unterstütztes Format. Erlaubt: "
            + ", ".join(sorted(SUPPORTED_SUFFIXES)),
        )

    settings = get_settings()
    suffix = Path(filename).suffix.lower()
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    dst = settings.documents_dir / stored_name
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    doc = Document(
        topic_id=topic_id,
        recording_id=recording_id,
        title=(title or "").strip() or Path(filename).stem,
        original_filename=filename,
        file_path=str(dst),
        content_type=file.content_type,
        status="uploaded",
    )
    session.add(doc)
    session.commit()
    session.refresh(doc)

    from ..jobs import enqueue_document_embedding

    enqueue_document_embedding(doc.id)
    return doc


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
    path = Path(doc.file_path)
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

    file_path = Path(doc.file_path)
    session.delete(doc)
    session.commit()
    try:
        file_path.unlink(missing_ok=True)
    except OSError as exc:
        print(f"Dokumentdatei konnte nach DB-Löschung nicht entfernt werden: {exc}")

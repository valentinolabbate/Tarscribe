"""Global job debug endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import cancel_job, serialize_job
from ..models import Job, JobStatus, Recording, Topic

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _status_value(status) -> str:
    return status.value if isinstance(status, JobStatus) else str(status)


def _serialize_job_detail(job: Job, session: Session) -> dict:
    payload = serialize_job(job)
    rec = session.get(Recording, job.recording_id)
    topic = session.get(Topic, rec.topic_id) if rec else None
    payload.update(
        {
            "recording_title": rec.title if rec else None,
            "topic_id": rec.topic_id if rec else None,
            "topic_name": topic.name if topic else None,
            "created_at": job.created_at.isoformat(),
            "updated_at": job.updated_at.isoformat(),
        }
    )
    return payload


@router.get("")
def list_jobs(
    status: str = "active",
    limit: int = 50,
    session: Session = Depends(get_session),
) -> list[dict]:
    query = select(Job)
    if status == "active":
        query = query.where(Job.status.in_([JobStatus.pending, JobStatus.running]))
    elif status != "all":
        try:
            query = query.where(Job.status == JobStatus(status))
        except ValueError as exc:
            raise HTTPException(400, f"Unbekannter Job-Status: {status}") from exc
    rows = session.exec(
        query.order_by(Job.updated_at.desc(), Job.created_at.desc()).limit(max(1, min(limit, 200)))
    ).all()
    return [_serialize_job_detail(job, session) for job in rows]


@router.post("/{job_id}/cancel")
def cancel_job_endpoint(job_id: int, session: Session = Depends(get_session)) -> dict:
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Auftrag nicht gefunden")
    if _status_value(job.status) not in {JobStatus.pending.value, JobStatus.running.value}:
        raise HTTPException(409, "Nur laufende oder wartende Aufträge können gestoppt werden")

    if cancel_job(job_id) is None:
        raise HTTPException(404, "Auftrag nicht gefunden")
    session.refresh(job)
    return _serialize_job_detail(job, session)

"""Background job runner for heavy ML work (ASR, later diarization).

A single-worker thread pool serializes GPU/CPU heavy tasks. Progress is
persisted on the Job row and broadcast over the WebSocket hub.
"""

from __future__ import annotations

import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import select

from .db import session_scope
from .models import (
    DiarizationRun,
    Job,
    JobPhase,
    JobStatus,
    Recording,
    RecordingStatus,
    Segment,
    Summary,
    Transcript,
    Word,
)
from .ws import hub

# Heavy models are not thread-safe and saturate the device; serialize to 1 worker.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tarscribe-job")


def serialize_job(job: Job) -> dict:
    """Return the shared REST/WS job event shape."""
    return {
        "type": "job",
        "job_id": job.id,
        "recording_id": job.recording_id,
        "phase": job.phase.value if isinstance(job.phase, JobPhase) else job.phase,
        "status": job.status.value if isinstance(job.status, JobStatus) else job.status,
        "progress": job.progress,
        "error": job.error,
    }


def _update_job(job_id: int, **fields) -> dict:
    fields["updated_at"] = datetime.now(timezone.utc)
    with session_scope() as s:
        job = s.get(Job, job_id)
        if not job:
            return {}
        for k, v in fields.items():
            setattr(job, k, v)
        s.add(job)
        s.flush()
        payload = serialize_job(job)
    hub.broadcast(payload)
    return payload


def _set_recording_status(recording_id: int, status: RecordingStatus) -> None:
    with session_scope() as s:
        rec = s.get(Recording, recording_id)
        if rec:
            rec.status = status
            s.add(rec)


def _save_summary_content(summary_id: int, content: str, model: str) -> None:
    """Persist partial LLM output so clients can recover missed WS deltas."""
    with session_scope() as s:
        summary = s.get(Summary, summary_id)
        if summary:
            summary.content = content
            summary.model = model
            s.add(summary)


def _run_asr(recording_id: int, job_id: int, override: str | None) -> None:
    from .ml.asr.factory import get_backend  # lazy: avoids importing ML at startup

    try:
        _update_job(job_id, status=JobStatus.running, progress=0.0)
        _set_recording_status(recording_id, RecordingStatus.transcribing)

        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            if not rec:
                raise RuntimeError("Aufnahme nicht gefunden")
            audio_path = Path(rec.audio_path)

        backend = get_backend(override)

        from .settings_store import load_prefs

        language = load_prefs().get("language")  # None => auto-detect

        last = {"t": 0.0}

        def progress(frac: float, _msg: str) -> None:
            # Throttle DB writes / broadcasts to ~4/sec.
            now = time.monotonic()
            if now - last["t"] >= 0.25 or frac >= 0.99:
                last["t"] = now
                _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        result = backend.transcribe(audio_path, language=language, progress=progress)
        backend = None  # drop strong ref so the model can be unloaded below

        # Persist transcript (replace any previous one — Stage A cache).
        with session_scope() as s:
            old = s.exec(
                select(Transcript).where(Transcript.recording_id == recording_id)
            ).all()
            # Delete child Words first (no ORM relationship => order it ourselves),
            # flush, then the transcripts, so the FK constraint holds.
            for t in old:
                for w in s.exec(select(Word).where(Word.transcript_id == t.id)).all():
                    s.delete(w)
            s.flush()
            for t in old:
                s.delete(t)
            s.flush()

            transcript = Transcript(
                recording_id=recording_id, asr_model=result.model, language=result.language
            )
            s.add(transcript)
            s.flush()
            for i, w in enumerate(result.words):
                s.add(
                    Word(
                        transcript_id=transcript.id,
                        idx=i,
                        start=w.start,
                        end=w.end,
                        text=w.text,
                        confidence=w.confidence,
                    )
                )

            rec = s.get(Recording, recording_id)
            if rec:
                rec.language = result.language
                rec.status = RecordingStatus.ready
                s.add(rec)

        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _update_job(job_id, status=JobStatus.failed, error=str(exc))
        _set_recording_status(recording_id, RecordingStatus.failed)
    finally:
        # Free the ASR model so the app doesn't keep it resident while idle.
        from .ml.lifecycle import unload_all

        unload_all()


def _run_diarization(recording_id: int, job_id: int, params_dict: dict) -> None:
    import json

    from .hardware import detect_hardware
    from .ml.diarization import DiarizationBackend, DiarizationParams
    from .settings_store import get_hf_token, load_prefs

    try:
        _update_job(job_id, status=JobStatus.running, progress=0.0)
        _set_recording_status(recording_id, RecordingStatus.diarizing)

        token = get_hf_token()
        if not token:
            raise RuntimeError(
                "Kein HuggingFace-Token hinterlegt. Bitte in den Einstellungen eintragen."
            )

        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            if not rec:
                raise RuntimeError("Aufnahme nicht gefunden")
            audio_path = Path(rec.audio_path)

        model_id = load_prefs().get("diarization_model") or "pyannote/speaker-diarization-community-1"
        device = detect_hardware().recommended_device

        last = {"t": 0.0}

        def progress(frac: float, _msg: str) -> None:
            now = time.monotonic()
            if now - last["t"] >= 0.25 or frac >= 0.99:
                last["t"] = now
                _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        backend = DiarizationBackend(hf_token=token, model_id=model_id, device=device)
        params = DiarizationParams(**params_dict)
        segments = backend.diarize(audio_path, params=params, progress=progress)
        backend = None  # drop strong ref to the pyannote pipeline

        # Persist as a new active run (Stage B, versioned).
        with session_scope() as s:
            for run in s.exec(
                select(DiarizationRun).where(DiarizationRun.recording_id == recording_id)
            ).all():
                run.is_active = False
                s.add(run)
            s.flush()
            run = DiarizationRun(
                recording_id=recording_id,
                model=model_id,
                params_json=json.dumps(params.to_dict()),
                num_speakers=len({seg.speaker for seg in segments}),
                is_active=True,
            )
            s.add(run)
            s.flush()
            for seg in segments:
                s.add(
                    Segment(
                        run_id=run.id, start=seg.start, end=seg.end, speaker_label=seg.speaker
                    )
                )
            rec = s.get(Recording, recording_id)
            if rec:
                rec.status = RecordingStatus.ready
                s.add(rec)

        # Auto-match speakers against the known-speaker library (best effort).
        try:
            from .ml.speaker_matching import apply_matches, match_recording

            threshold = float(load_prefs().get("speaker_match_threshold", 0.5))
            with session_scope() as s:
                matches = match_recording(s, recording_id, threshold)
                apply_matches(s, recording_id, matches)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _update_job(job_id, status=JobStatus.failed, error=str(exc))
        _set_recording_status(recording_id, RecordingStatus.ready)
    finally:
        # Free the diarization + embedding models after the pipeline run.
        from .ml.lifecycle import unload_all

        unload_all()


def _assemble_transcript(session, recording_id: int) -> tuple[str, list[str]]:
    """Speaker-annotated transcript text + speaker names for the LLM."""
    from sqlmodel import select as _select

    from .ml.alignment import build_utterances
    from .ml.diarization import SpeakerSegment
    from .models import DiarizationRun, Segment, SpeakerLabel
    from .overlay import load_overlay

    transcript = session.exec(
        _select(Transcript).where(Transcript.recording_id == recording_id)
    ).first()
    if not transcript:
        return "", []
    words = session.exec(
        _select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
    ).all()
    run = session.exec(
        _select(DiarizationRun).where(
            DiarizationRun.recording_id == recording_id, DiarizationRun.is_active == True  # noqa: E712
        )
    ).first()
    if not run:
        return "".join(w.text for w in words).strip(), []

    segs = session.exec(_select(Segment).where(Segment.run_id == run.id).order_by(Segment.start)).all()
    aligned = [SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker_label) for s in segs]
    relabel, reassigns = load_overlay(session, recording_id)
    labels = session.exec(
        _select(SpeakerLabel).where(SpeakerLabel.recording_id == recording_id)
    ).all()
    name_map = {lab.original_label: lab.display_name for lab in labels if lab.display_name}
    utts = build_utterances(words, aligned, reassigns, relabel)
    lines = [f"{name_map.get(u.speaker, u.speaker)}: {u.text}" for u in utts]
    speakers = sorted({name_map.get(u.speaker, u.speaker) for u in utts})
    return "\n".join(lines), speakers


def _run_summary(recording_id: int, job_id: int, template_id: int, summary_id: int) -> None:
    from . import llm as L
    from .models import SummaryTemplate, Topic

    acc = ""
    model = ""
    last_save = 0.0
    try:
        _update_job(job_id, status=JobStatus.running, progress=0.05)
        cfg = L.get_llm_config()
        if not cfg["model"]:
            raise RuntimeError("Kein LLM-Modell gewählt. Bitte in den Einstellungen konfigurieren.")

        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            tpl = s.get(SummaryTemplate, template_id)
            if not rec or not tpl:
                raise RuntimeError("Aufnahme oder Vorlage nicht gefunden")
            topic = s.get(Topic, rec.topic_id)
            topic_name = topic.name if topic else ""
            rec_duration = rec.duration_sec
            rec_created = rec.created_at
            tpl_system = tpl.system_prompt
            tpl_user = tpl.user_prompt_template
            text, speakers = _assemble_transcript(s, recording_id)
        if not text:
            raise RuntimeError("Kein Transkript vorhanden")

        model = cfg["model"]
        base = cfg["base_url"]

        # Map step: condense long transcripts before applying the template.
        chunks = L.chunk_text(text)
        if len(chunks) > 1:
            notes: list[str] = []
            for i, ch in enumerate(chunks):
                _update_job(job_id, progress=0.05 + 0.5 * (i / len(chunks)))
                msgs = [
                    {"role": "system", "content": "Fasse den folgenden Transkript-Abschnitt in knappen Stichpunkten zusammen, behalte Sprecher und wichtige Fakten."},
                    {"role": "user", "content": ch},
                ]
                notes.append("".join(L.stream_chat(msgs, model, base)))
            text = "\n".join(notes)

        ctx = L.build_context(rec_duration, rec_created, topic_name, text, speakers)
        user_prompt = L.render_template(tpl_user, ctx)
        messages = [
            {"role": "system", "content": tpl_system or "Du bist ein hilfreicher Assistent."},
            {"role": "user", "content": user_prompt},
        ]

        _update_job(job_id, progress=0.6)
        for delta in L.stream_chat(messages, model, base):
            acc += delta
            now = time.monotonic()
            if now - last_save >= 0.25:
                _save_summary_content(summary_id, acc, model)
                last_save = now
            hub.broadcast(
                {"type": "summary", "recording_id": recording_id, "summary_id": summary_id, "delta": delta, "done": False}
            )

        _save_summary_content(summary_id, acc, model)
        hub.broadcast(
            {"type": "summary", "recording_id": recording_id, "summary_id": summary_id, "delta": "", "done": True}
        )
        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if acc:
            _save_summary_content(summary_id, acc, model)
        _update_job(job_id, status=JobStatus.failed, error=str(exc))
        hub.broadcast(
            {"type": "summary", "recording_id": recording_id, "summary_id": summary_id, "delta": "", "done": True, "error": str(exc)}
        )


def enqueue_summary(recording_id: int, template_id: int, summary_id: int) -> int:
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
    _executor.submit(_run_summary, recording_id, job_id, template_id, summary_id)
    return job_id


def enqueue_diarization(recording_id: int, params_dict: dict | None = None) -> int:
    with session_scope() as s:
        job = Job(
            recording_id=recording_id, phase=JobPhase.diarization, status=JobStatus.pending
        )
        s.add(job)
        s.flush()
        job_id = job.id
    _executor.submit(_run_diarization, recording_id, job_id, params_dict or {})
    return job_id


def enqueue_asr(recording_id: int, override: str | None = None) -> int:
    """Create an ASR job row and schedule it. Returns the job id."""
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.asr, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
        rec = s.get(Recording, recording_id)
        if rec:
            rec.status = RecordingStatus.queued
            s.add(rec)
    _executor.submit(_run_asr, recording_id, job_id, override)
    return job_id

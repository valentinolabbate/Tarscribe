"""Background job runner for heavy ML work (ASR, later diarization).

A single-worker thread pool serializes GPU/CPU heavy tasks. Progress is
persisted on the Job row and broadcast over the WebSocket hub.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from concurrent.futures import Future, ThreadPoolExecutor
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import select

from .db import session_scope
from .models import (
    ActionItem,
    DiarizationRun,
    Job,
    JobPhase,
    JobStatus,
    Recording,
    RecordingStatus,
    Segment,
    Summary,
    Topic,
    Transcript,
    Word,
)
from .ws import hub

# Heavy models are not thread-safe and saturate the device; serialize to 1 worker.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tarscribe-job")
# Embedding (RAG) jobs are I/O-bound HTTP calls, not heavy local ML. Run them on a
# dedicated worker so a bulk reindex never blocks ASR / diarization / summaries.
_embed_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tarscribe-embed")
_async_loop: asyncio.AbstractEventLoop | None = None
_owned_async_loop: asyncio.AbstractEventLoop | None = None
_owned_async_loop_thread: threading.Thread | None = None
_async_loop_lock = threading.Lock()
_llm_futures: dict[int, Future] = {}
_llm_futures_lock = threading.Lock()


class JobCanceled(RuntimeError):
    """Raised inside worker threads when a user cancels a job."""


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _async_loop
    with _async_loop_lock:
        _async_loop = loop


def _ensure_async_loop() -> asyncio.AbstractEventLoop:
    global _owned_async_loop, _owned_async_loop_thread
    with _async_loop_lock:
        if (
            _async_loop is not None
            and _async_loop.is_running()
            and not _async_loop.is_closed()
        ):
            return _async_loop
        if (
            _owned_async_loop is not None
            and _owned_async_loop.is_running()
            and not _owned_async_loop.is_closed()
        ):
            return _owned_async_loop

        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run_loop() -> None:
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()

        thread = threading.Thread(
            target=run_loop,
            name="tarscribe-async-jobs",
            daemon=True,
        )
        thread.start()
        ready.wait(timeout=2)
        _owned_async_loop = loop
        _owned_async_loop_thread = thread
        return loop


def _submit_llm_job(
    job_id: int,
    coro_fn: Callable[..., Awaitable[None]],
    *args,
) -> Future:
    global _async_loop
    loop = _ensure_async_loop()
    coro = coro_fn(*args)
    try:
        future = asyncio.run_coroutine_threadsafe(coro, loop)
    except RuntimeError:
        coro.close()
        with _async_loop_lock:
            if _async_loop is loop:
                _async_loop = None
        loop = _ensure_async_loop()
        future = asyncio.run_coroutine_threadsafe(coro_fn(*args), loop)
    with _llm_futures_lock:
        _llm_futures[job_id] = future

    def cleanup(done: Future) -> None:
        with _llm_futures_lock:
            if _llm_futures.get(job_id) is done:
                _llm_futures.pop(job_id, None)

    future.add_done_callback(cleanup)
    return future


def _cancel_llm_future(job_id: int) -> None:
    with _llm_futures_lock:
        future = _llm_futures.get(job_id)
    if future is not None and not future.done():
        future.cancel()


def _status_value(status) -> str:
    return status.value if isinstance(status, JobStatus) else str(status)


def _is_job_canceled(job_id: int) -> bool:
    with session_scope() as s:
        job = s.get(Job, job_id)
        return bool(job and _status_value(job.status) == JobStatus.canceled.value)


def _raise_if_canceled(job_id: int) -> None:
    if _is_job_canceled(job_id):
        raise JobCanceled()


def _start_job(job_id: int, progress: float) -> None:
    _raise_if_canceled(job_id)
    _update_job(job_id, status=JobStatus.running, progress=progress)
    _raise_if_canceled(job_id)


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
        requested_status = fields.get("status")
        if (
            _status_value(job.status) == JobStatus.canceled.value
            and _status_value(requested_status) != JobStatus.canceled.value
        ):
            return serialize_job(job)
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


def _set_recording_status_after_cancel(recording_id: int) -> None:
    with session_scope() as s:
        rec = s.get(Recording, recording_id)
        if not rec:
            return
        has_transcript = (
            s.exec(select(Transcript).where(Transcript.recording_id == recording_id)).first()
            is not None
        )
        rec.status = RecordingStatus.ready if has_transcript else RecordingStatus.uploaded
        s.add(rec)


def _set_recording_status_after_asr_failure(recording_id: int) -> None:
    with session_scope() as s:
        rec = s.get(Recording, recording_id)
        if not rec:
            return
        transcripts = s.exec(
            select(Transcript).where(Transcript.recording_id == recording_id)
        ).all()
        has_transcript_words = False
        for transcript in transcripts:
            if transcript.id is None:
                continue
            first_word = s.exec(
                select(Word.id).where(Word.transcript_id == transcript.id).limit(1)
            ).first()
            if first_word is not None:
                has_transcript_words = True
                break
        rec.status = RecordingStatus.ready if has_transcript_words else RecordingStatus.failed
        s.add(rec)


def cancel_job(job_id: int) -> dict | None:
    """Mark a pending/running job as canceled and broadcast the update."""
    reset_recording_id: int | None = None
    with session_scope() as s:
        job = s.get(Job, job_id)
        if not job:
            return None
        if _status_value(job.status) not in {JobStatus.pending.value, JobStatus.running.value}:
            return serialize_job(job)
        if job.phase in (JobPhase.asr, JobPhase.diarization):
            reset_recording_id = job.recording_id
        job.status = JobStatus.canceled
        job.updated_at = datetime.now(timezone.utc)
        s.add(job)
        s.flush()
        payload = serialize_job(job)
    _cancel_llm_future(job_id)
    if reset_recording_id is not None:
        _set_recording_status_after_cancel(reset_recording_id)
    hub.broadcast(payload)
    return payload


def _save_summary_content(summary_id: int, content: str, model: str) -> None:
    """Persist partial LLM output so clients can recover missed WS deltas."""
    with session_scope() as s:
        summary = s.get(Summary, summary_id)
        if summary:
            summary.content = content
            summary.model = model
            s.add(summary)


def _save_summary_sources(summary_id: int, hits: list[dict]) -> None:
    """Persist the topic-knowledge passages woven into a summary (for the UI).

    Stored as a compact JSON list (no full passage text) so the recording detail
    can show which files/recordings the summary drew on.
    """
    import json

    sources = [
        {
            "index": i,
            "recording_id": h.get("recording_id"),
            "recording_title": h.get("recording_title"),
            "document_id": h.get("document_id"),
            "source_type": h.get("source_type"),
        }
        for i, h in enumerate(hits, 1)
    ]
    with session_scope() as s:
        summary = s.get(Summary, summary_id)
        if summary:
            summary.sources = json.dumps(sources, ensure_ascii=False)
            s.add(summary)


def _run_asr(recording_id: int, job_id: int, override: str | None) -> None:
    from .ml.asr.factory import get_backend  # lazy: avoids importing ML at startup

    try:
        _start_job(job_id, progress=0.0)
        _set_recording_status(recording_id, RecordingStatus.transcribing)

        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            if not rec:
                raise RuntimeError("Aufnahme nicht gefunden")
            audio_path = Path(rec.audio_path)

        if not audio_path.exists():
            raise RuntimeError(
                "Audiodatei nicht gefunden. Bitte importiere die Aufnahme erneut."
            )

        from .ml.lifecycle import asr_lock
        from .settings_store import load_prefs

        language = load_prefs().get("language")  # None => auto-detect

        last = {"t": 0.0}

        def progress(frac: float, _msg: str) -> None:
            _raise_if_canceled(job_id)
            # Throttle DB writes / broadcasts to ~4/sec.
            now = time.monotonic()
            if now - last["t"] >= 0.25 or frac >= 0.99:
                last["t"] = now
                _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        # Hold the ASR lock across *both* model retrieval and transcription so
        # live-analysis ticks (which share the cached model) cannot run — or
        # swap the model — concurrently.
        with asr_lock:
            backend = get_backend(override)
            result = backend.transcribe(audio_path, language=language, progress=progress)
        backend = None  # drop strong ref so the model can be unloaded below
        _raise_if_canceled(job_id)

        if not result.words:
            raise RuntimeError(
                "Keine Sprache erkannt. Bitte prüfe, ob die Aufnahme hörbaren Ton enthält."
            )

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

        _maybe_postprocess_dictation(recording_id)
        _update_job(job_id, status=JobStatus.done, progress=1.0)
        schedule_reindex(recording_id)
    except JobCanceled:
        _update_job(job_id, status=JobStatus.canceled)
        _set_recording_status_after_cancel(recording_id)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
            _set_recording_status_after_cancel(recording_id)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))
            _set_recording_status_after_asr_failure(recording_id)
    finally:
        # Free the ASR model so the app doesn't keep it resident while idle.
        from .ml.lifecycle import unload_all

        unload_all()


def _run_diarization(recording_id: int, job_id: int, params_dict: dict) -> None:
    import json

    from .hardware import detect_hardware
    from .ml.diarization import DiarizationBackend, DiarizationParams
    from .performance_profiles import resolve_diarization_selection
    from .settings_store import get_hf_token, load_prefs

    try:
        _start_job(job_id, progress=0.0)
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

        prefs = load_prefs()
        diarization_selection = resolve_diarization_selection(prefs, detect_hardware())
        model_id = diarization_selection["model_id"]
        device = diarization_selection["device"]

        last = {"t": 0.0}

        def progress(frac: float, _msg: str) -> None:
            _raise_if_canceled(job_id)
            now = time.monotonic()
            if now - last["t"] >= 0.25 or frac >= 0.99:
                last["t"] = now
                _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        from .ml.lifecycle import diar_lock

        backend = DiarizationBackend(hf_token=token, model_id=model_id, device=device)
        params = DiarizationParams(**params_dict)
        with diar_lock:
            segments = backend.diarize(audio_path, params=params, progress=progress)
        backend = None  # drop strong ref to the pyannote pipeline
        _raise_if_canceled(job_id)

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

            if diarization_selection.get("speaker_matching_enabled", True):
                threshold = float(load_prefs().get("speaker_match_threshold", 0.5))
                with session_scope() as s:
                    matches = match_recording(s, recording_id, threshold)
                    apply_matches(s, recording_id, matches)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

        _update_job(job_id, status=JobStatus.done, progress=1.0)
        # Re-diarization changes speaker assignment -> re-embed the (re-labeled) text.
        schedule_reindex(recording_id)
    except JobCanceled:
        _update_job(job_id, status=JobStatus.canceled)
        _set_recording_status_after_cancel(recording_id)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
            _set_recording_status_after_cancel(recording_id)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))
            # Diarization is optional: a recording that already has a transcript stays
            # usable ("ready"). But without a transcript, "ready" would render a blank
            # detail page, so fall back to "failed" so the user can re-transcribe.
            with session_scope() as s:
                has_transcript = (
                    s.exec(
                        select(Transcript).where(Transcript.recording_id == recording_id)
                    ).first()
                    is not None
                )
            _set_recording_status(
                recording_id,
                RecordingStatus.ready if has_transcript else RecordingStatus.failed,
            )
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


_KNOWLEDGE_TYPE_LABELS = {
    "document": "Datei",
    "summary": "Zusammenfassung",
    "transcript": "Transkript",
}


def _format_topic_knowledge(hits: list[dict]) -> str:
    """Render retrieved topic passages into a labeled, numbered context block."""
    lines: list[str] = []
    for i, h in enumerate(hits, 1):
        title = h.get("recording_title") or "Quelle"
        type_label = _KNOWLEDGE_TYPE_LABELS.get(h.get("source_type"), h.get("source_type") or "")
        text = (h.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{i}] {title} ({type_label}):\n{text}")
    return "\n\n".join(lines)


def _run_summary(recording_id: int, job_id: int, template_id: int, summary_id: int) -> None:
    asyncio.run(_run_summary_async(recording_id, job_id, template_id, summary_id))


async def _run_summary_async(
    recording_id: int, job_id: int, template_id: int, summary_id: int
) -> None:
    from . import llm as L
    from .models import SummaryTemplate, Topic

    acc = ""
    model = ""
    last_save = 0.0
    try:
        _start_job(job_id, progress=0.05)
        cfg = L.get_llm_config()
        if not cfg["model"]:
            raise RuntimeError("Kein Chat-Modell gewählt. Bitte in den Einstellungen konfigurieren.")

        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            tpl = s.get(SummaryTemplate, template_id)
            if not rec or not tpl:
                raise RuntimeError("Aufnahme oder Vorlage nicht gefunden")
            topic = s.get(Topic, rec.topic_id)
            topic_name = topic.name if topic else ""
            topic_id = rec.topic_id
            rec_title = rec.title
            rec_duration = rec.duration_sec
            rec_created = rec.created_at
            tpl_system = tpl.system_prompt
            tpl_user = tpl.user_prompt_template
            text, speakers = _assemble_transcript(s, recording_id)
        if not text:
            raise RuntimeError("Kein Transkript vorhanden")

        model = cfg["model"]
        base = cfg["base_url"]
        api_key = cfg.get("api_key")
        temperature = cfg.get("temperature", 0.3)
        top_p = cfg.get("top_p")
        top_k = cfg.get("top_k")
        max_tokens = cfg.get("max_tokens")
        reasoning_effort = cfg.get("reasoning_effort")
        provider = cfg.get("provider")

        from .settings_store import load_prefs as _load_prefs
        prefs = _load_prefs()
        chunk_size = int(prefs.get("llm_chunk_size") or 48000)
        use_topic_knowledge = bool(prefs.get("summary_use_topic_knowledge", True))

        async def _chat(msgs: list[dict]) -> str:
            content = ""
            async for delta in L.astream_chat(
                msgs,
                model,
                base,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                max_tokens=max_tokens,
                api_key=api_key,
                reasoning_effort=reasoning_effort,
                provider=provider,
            ):
                content += delta
            return content

        # Map step: condense long transcripts before applying the template.
        chunks = L.chunk_text(text, size=chunk_size)
        if len(chunks) > 1:
            notes: list[str] = []
            for i, ch in enumerate(chunks):
                _raise_if_canceled(job_id)
                _update_job(job_id, progress=0.05 + 0.5 * (i / len(chunks)))
                msgs = [
                    {"role": "system", "content": "Fasse den folgenden Transkript-Abschnitt in knappen Stichpunkten zusammen, behalte Sprecher und wichtige Fakten."},
                    {"role": "user", "content": ch},
                ]
                notes.append(await _chat(msgs))
                _raise_if_canceled(job_id)
            text = "\n".join(notes)

        ctx = L.build_context(
            rec_duration,
            rec_created,
            topic_name,
            text,
            speakers,
            recording_title=rec_title,
        )
        user_prompt = L.render_template(tpl_user, ctx)
        system_prompt = tpl_system or "Du bist ein hilfreicher Assistent."

        # Enrich the summary with relevant knowledge from the same topic (other
        # transcripts, summaries and uploaded documents). Best-effort: any failure
        # (RAG off, embedding endpoint down, no hits) just summarizes as before.
        if use_topic_knowledge:
            from . import rag as R

            if R.rag_enabled():
                try:
                    with session_scope() as s:
                        hits = R.retrieve_topic_knowledge(
                            s, text, topic_id, exclude_recording_id=recording_id
                        )
                    block = _format_topic_knowledge(hits)
                    if block:
                        _save_summary_sources(summary_id, hits)
                        system_prompt += (
                            "\n\nDir steht zusätzlicher Kontext aus demselben Themenbereich "
                            "zur Verfügung (Dateien, andere Transkripte und Zusammenfassungen). "
                            "Das aktuelle Transkript bleibt immer die Primärquelle. Nutze den "
                            "Zusatzkontext nur, wo er inhaltlich eindeutig zur Aufnahme passt, um "
                            "die Zusammenfassung präziser und vollständiger zu machen. Erfinde "
                            "nichts, übernimm nichts Unpassendes und lehne die Aufgabe nie wegen "
                            "abweichendem Zusatzkontext ab."
                        )
                        user_prompt += (
                            "\n\n--- Optionaler, nachrangiger Kontext aus dem Themenbereich ---\n"
                            + block
                        )
                except Exception:  # noqa: BLE001 - never fail a summary over enrichment
                    traceback.print_exc()

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        _update_job(job_id, progress=0.6)
        async for delta in L.astream_chat(
            messages,
            model,
            base,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            max_tokens=max_tokens,
            api_key=api_key,
            reasoning_effort=reasoning_effort,
            provider=provider,
        ):
            _raise_if_canceled(job_id)
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
        schedule_reindex(recording_id)
    except (JobCanceled, asyncio.CancelledError):
        if acc:
            _save_summary_content(summary_id, acc, model)
        _update_job(job_id, status=JobStatus.canceled)
        hub.broadcast(
            {"type": "summary", "recording_id": recording_id, "summary_id": summary_id, "delta": "", "done": True, "error": "Abgebrochen"}
        )
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if acc:
            _save_summary_content(summary_id, acc, model)
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))
        hub.broadcast(
            {"type": "summary", "recording_id": recording_id, "summary_id": summary_id, "delta": "", "done": True, "error": str(exc)}
        )


def _llm_chat_fn():
    """Non-streaming chat callable from the configured chat model (raises if unconfigured)."""
    from . import llm as L

    cfg = L.get_llm_config()
    if not cfg["model"]:
        raise RuntimeError("Kein Chat-Modell gewählt. Bitte in den Einstellungen konfigurieren.")

    def _chat(msgs: list[dict]) -> str:
        return "".join(
            L.stream_chat(
                msgs,
                cfg["model"],
                cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=cfg.get("reasoning_effort"),
                provider=cfg.get("provider"),
            )
        )

    return _chat


def _llm_chat_fn_async():
    from . import llm as L

    cfg = L.get_llm_config()
    if not cfg["model"]:
        raise RuntimeError("Kein Chat-Modell gewählt. Bitte in den Einstellungen konfigurieren.")

    async def _chat(msgs: list[dict]) -> str:
        content = ""
        async for delta in L.astream_chat(
            msgs,
            cfg["model"],
            cfg["base_url"],
            temperature=cfg.get("temperature", 0.3),
            top_p=cfg.get("top_p"),
            top_k=cfg.get("top_k"),
            max_tokens=cfg.get("max_tokens"),
            api_key=cfg.get("api_key"),
            reasoning_effort=cfg.get("reasoning_effort"),
            provider=cfg.get("provider"),
        ):
            content += delta
        return content

    return _chat


def _run_action_items(recording_id: int, job_id: int) -> None:
    asyncio.run(_run_action_items_async(recording_id, job_id))


async def _run_action_items_async(recording_id: int, job_id: int) -> None:
    from . import analysis
    from .calendar_sync import sync_action_item
    from .models import ActionItem
    from .settings_store import load_prefs

    try:
        _start_job(job_id, progress=0.05)
        chat = _llm_chat_fn_async()
        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            reference_date = rec.created_at.date().isoformat() if rec and rec.created_at else None
            text, speakers = _assemble_transcript(s, recording_id)
        if not text:
            raise RuntimeError("Kein Transkript vorhanden")

        chunk_size = int(load_prefs().get("llm_chunk_size") or 48000)

        def progress(frac: float) -> None:
            _raise_if_canceled(job_id)
            _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        items = await analysis.extract_action_items_async(
            chat,
            text,
            speakers,
            chunk_size=chunk_size,
            progress=progress,
            reference_date=reference_date,
        )
        _raise_if_canceled(job_id)

        with session_scope() as s:
            old = s.exec(
                select(ActionItem).where(ActionItem.recording_id == recording_id)
            ).all()
            # Re-extraction replaces the list but keeps check-offs for unchanged texts.
            done_texts = {analysis._norm_text(o.text) for o in old if o.done}
            for o in old:
                s.delete(o)
            s.flush()
            for it in items:
                item = ActionItem(
                    recording_id=recording_id,
                    kind=it["kind"],
                    text=it["text"],
                    assignee=it.get("assignee"),
                    due=it.get("due"),
                    due_date=it.get("due_date"),
                    done=analysis._norm_text(it["text"]) in done_texts,
                )
                sync_action_item(s, item)
                s.add(item)
        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except (JobCanceled, asyncio.CancelledError):
        _update_job(job_id, status=JobStatus.canceled)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))


def _maybe_postprocess_dictation(recording_id: int) -> None:
    from . import analysis
    from .calendar_sync import sync_action_item
    from .settings_store import load_prefs

    with session_scope() as s:
        rec = s.get(Recording, recording_id)
        if not rec or rec.kind != "dictation":
            return
        reference_date = rec.created_at.date().isoformat() if rec.created_at else None
        text, _speakers = _assemble_transcript(s, recording_id)
        topics = [
            (topic.id, topic.name)
            for topic in s.exec(select(Topic).order_by(Topic.created_at)).all()
            if topic.id is not None
        ]
    if not text:
        return

    try:
        chat = _llm_chat_fn()
    except Exception:
        return

    topic_names = [name for _topic_id, name in topics]
    topic_by_name = {name.casefold(): topic_id for topic_id, name in topics}
    inbox = topic_by_name.get("inbox")
    chunk_size = int(load_prefs().get("llm_chunk_size") or 48000)

    try:
        result = analysis.analyze_dictation(
            chat,
            text,
            topic_names,
            chunk_size=chunk_size,
            reference_date=reference_date,
        )
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return

    with session_scope() as s:
        rec = s.get(Recording, recording_id)
        if not rec or rec.kind != "dictation":
            return
        if result.get("title"):
            rec.title = result["title"]

        target_name = str(result.get("topic_name") or "").casefold()
        target_topic_id = topic_by_name.get(target_name)
        confidence = float(result.get("topic_confidence") or 0)
        if target_topic_id and target_topic_id != inbox and confidence >= 0.75:
            rec.topic_id = target_topic_id
        s.add(rec)

        old = s.exec(select(ActionItem).where(ActionItem.recording_id == recording_id)).all()
        for item in old:
            s.delete(item)
        s.flush()
        for item in result.get("action_items") or []:
            action = ActionItem(
                recording_id=recording_id,
                kind=item["kind"],
                text=item["text"],
                assignee=item.get("assignee"),
                due=item.get("due"),
                due_date=item.get("due_date"),
                # Dictation captures the user's own notes — always surface them
                # in the Tasks area regardless of the detected assignee.
                include_in_tasks=True,
            )
            sync_action_item(s, action)
            s.add(action)


def _run_chapters(recording_id: int, job_id: int) -> None:
    asyncio.run(_run_chapters_async(recording_id, job_id))


async def _run_chapters_async(recording_id: int, job_id: int) -> None:
    from . import analysis
    from .models import Chapter
    from .rag import load_utterances
    from .settings_store import load_prefs

    try:
        _start_job(job_id, progress=0.1)
        chat = _llm_chat_fn_async()
        with session_scope() as s:
            rec = s.get(Recording, recording_id)
            if not rec:
                raise RuntimeError("Aufnahme nicht gefunden")
            duration = rec.duration_sec
            utts = load_utterances(s, recording_id)
        if not utts:
            raise RuntimeError("Kein Transkript vorhanden")

        chunk_size = int(load_prefs().get("llm_chunk_size") or 48000)
        _update_job(job_id, progress=0.3)
        chapters = await analysis.generate_chapters_async(
            chat, utts, duration, chunk_size=chunk_size
        )
        _raise_if_canceled(job_id)
        if not chapters:
            raise RuntimeError("Das LLM hat keine verwertbaren Kapitel geliefert.")

        with session_scope() as s:
            for old in s.exec(
                select(Chapter).where(Chapter.recording_id == recording_id)
            ).all():
                s.delete(old)
            s.flush()
            for i, ch in enumerate(chapters):
                s.add(
                    Chapter(
                        recording_id=recording_id,
                        idx=i,
                        start=ch["start"],
                        end=ch.get("end"),
                        title=ch["title"],
                    )
        )
        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except (JobCanceled, asyncio.CancelledError):
        _update_job(job_id, status=JobStatus.canceled)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))


def enqueue_action_items(recording_id: int) -> int:
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.action_items, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
    _submit_llm_job(job_id, _run_action_items_async, recording_id, job_id)
    return job_id


def enqueue_chapters(recording_id: int) -> int:
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.chapters, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
    _submit_llm_job(job_id, _run_chapters_async, recording_id, job_id)
    return job_id


def _run_embedding(recording_id: int, job_id: int) -> None:
    from . import rag

    try:
        _start_job(job_id, progress=0.0)

        last = {"t": 0.0}

        def progress(frac: float) -> None:
            _raise_if_canceled(job_id)
            now = time.monotonic()
            if now - last["t"] >= 0.25 or frac >= 0.99:
                last["t"] = now
                _update_job(job_id, progress=round(frac, 4), status=JobStatus.running)

        with session_scope() as s:
            rag.index_recording(s, recording_id, progress=progress)
        _raise_if_canceled(job_id)

        _update_job(job_id, status=JobStatus.done, progress=1.0)
    except JobCanceled:
        _update_job(job_id, status=JobStatus.canceled)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        if _is_job_canceled(job_id):
            _update_job(job_id, status=JobStatus.canceled)
        else:
            _update_job(job_id, status=JobStatus.failed, error=str(exc))


def enqueue_embedding(recording_id: int) -> int | None:
    """Schedule a RAG (re)index for one recording. No-op when RAG is disabled."""
    from . import rag

    if not rag.rag_enabled():
        return None
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.embedding, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
    _embed_executor.submit(_run_embedding, recording_id, job_id)
    return job_id


def _set_document_status(document_id: int, status: str, error: str | None = None) -> None:
    from .models import Document

    with session_scope() as s:
        doc = s.get(Document, document_id)
        if doc:
            doc.status = status
            doc.error = error
            s.add(doc)
    hub.broadcast(
        {"type": "document", "document_id": document_id, "status": status, "error": error}
    )


def _run_document_embedding(document_id: int) -> None:
    from . import rag

    try:
        _set_document_status(document_id, "indexing")
        with session_scope() as s:
            rag.index_document(s, document_id)
        _set_document_status(document_id, "ready")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _set_document_status(document_id, "failed", str(exc))


def enqueue_document_embedding(document_id: int) -> int | None:
    """Schedule indexing of an uploaded document. No-op when RAG is disabled.

    Runs on the dedicated embedding worker so it never blocks ASR/diarization.
    """
    from . import rag

    if not rag.rag_enabled():
        return None
    _embed_executor.submit(_run_document_embedding, document_id)
    return document_id


def schedule_reindex(recording_id: int) -> None:
    """Best-effort RAG reindex trigger after transcript/speaker/summary changes.

    Call via the module (``jobs.schedule_reindex``) so it stays patchable in tests.
    """
    try:
        enqueue_embedding(recording_id)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def enqueue_summary(recording_id: int, template_id: int, summary_id: int) -> int:
    with session_scope() as s:
        job = Job(recording_id=recording_id, phase=JobPhase.summarize, status=JobStatus.pending)
        s.add(job)
        s.flush()
        job_id = job.id
    _submit_llm_job(job_id, _run_summary_async, recording_id, job_id, template_id, summary_id)
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

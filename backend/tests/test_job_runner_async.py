"""Async LLM job scheduling and cancellation tests."""

from __future__ import annotations

import asyncio
import importlib
import tempfile
import threading
import time

import pytest
from sqlmodel import Session


@pytest.fixture()
def db_env(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="tarscribe-async-job-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)
    db.init_db()
    return db


def _recording(db_env):
    from tarscribe_backend.models import Recording, Topic

    with Session(db_env.get_engine()) as session:
        topic = Topic(name="Async")
        session.add(topic)
        session.flush()
        recording = Recording(topic_id=topic.id, title="Meeting", audio_path="/tmp/missing.wav")
        session.add(recording)
        session.commit()
        return recording.id


def _summary_job(db_env):
    from tarscribe_backend.models import (
        Job,
        JobPhase,
        JobStatus,
        Recording,
        Summary,
        SummaryTemplate,
        Topic,
        Transcript,
        Word,
    )

    with Session(db_env.get_engine()) as session:
        topic = Topic(name="Async")
        session.add(topic)
        session.flush()
        recording = Recording(topic_id=topic.id, title="Meeting", audio_path="/tmp/missing.wav")
        session.add(recording)
        session.flush()
        transcript = Transcript(recording_id=recording.id, asr_model="test")
        session.add(transcript)
        session.flush()
        session.add(Word(transcript_id=transcript.id, idx=0, start=0, end=1, text="Hallo"))
        template = SummaryTemplate(name="Kurz", user_prompt_template="{{transcript}}")
        session.add(template)
        session.flush()
        summary = Summary(recording_id=recording.id, template_id=template.id, model="")
        session.add(summary)
        job = Job(recording_id=recording.id, phase=JobPhase.summarize, status=JobStatus.pending)
        session.add(job)
        session.commit()
        return recording.id, template.id, summary.id, job.id


def _wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def test_llm_jobs_do_not_use_cpu_executor(db_env, monkeypatch):
    import tarscribe_backend.jobs as jobs
    from tarscribe_backend.models import Summary, SummaryTemplate

    recording_id = _recording(db_env)
    with Session(db_env.get_engine()) as session:
        template = SummaryTemplate(name="Kurz", user_prompt_template="{{transcript}}")
        session.add(template)
        session.flush()
        summary = Summary(recording_id=recording_id, template_id=template.id, model="")
        session.add(summary)
        session.commit()
        template_id = template.id
        summary_id = summary.id

    def fail_cpu_submit(*_args, **_kwargs):
        raise AssertionError("LLM jobs must not use the CPU executor")

    submitted: list[str] = []
    monkeypatch.setattr(jobs._executor, "submit", fail_cpu_submit)
    monkeypatch.setattr(
        jobs,
        "_submit_llm_job",
        lambda _job_id, coro_fn, *_args: submitted.append(coro_fn.__name__),
    )

    jobs.enqueue_action_items(recording_id)
    jobs.enqueue_chapters(recording_id)
    jobs.enqueue_summary(recording_id, template_id, summary_id)

    assert submitted == [
        "_run_action_items_async",
        "_run_chapters_async",
        "_run_summary_async",
    ]


def test_llm_scheduler_falls_back_when_bound_loop_is_closed(db_env):
    import tarscribe_backend.jobs as jobs

    closed_loop = asyncio.new_event_loop()
    closed_loop.close()
    jobs.bind_loop(closed_loop)
    ran = threading.Event()

    async def noop() -> None:
        ran.set()

    future = jobs._submit_llm_job(999999, noop)

    future.result(timeout=2)
    assert ran.is_set()


def test_cancel_llm_job_closes_streaming_request(db_env, monkeypatch):
    import tarscribe_backend.jobs as jobs
    import tarscribe_backend.llm as llm
    from tarscribe_backend.models import Job, JobStatus, Summary
    from tarscribe_backend.settings_store import save_prefs

    recording_id, template_id, summary_id, job_id = _summary_job(db_env)
    save_prefs({"summary_use_topic_knowledge": False})
    started = threading.Event()
    closed = threading.Event()

    async def fake_astream_chat(*_args, **_kwargs):
        started.set()
        try:
            yield "Teil"
            while True:
                await asyncio.sleep(0.05)
        finally:
            closed.set()

    monkeypatch.setattr(
        llm,
        "get_llm_config",
        lambda: {"model": "local-test", "base_url": "http://llm"},
    )
    monkeypatch.setattr(llm, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(jobs, "schedule_reindex", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(jobs.hub, "broadcast", lambda *_args, **_kwargs: None)

    future = jobs._submit_llm_job(
        job_id,
        jobs._run_summary_async,
        recording_id,
        job_id,
        template_id,
        summary_id,
    )

    assert started.wait(timeout=2)
    payload = jobs.cancel_job(job_id)

    assert payload is not None
    assert payload["status"] == "canceled"
    assert closed.wait(timeout=2)
    assert _wait_until(future.done)

    with Session(db_env.get_engine()) as session:
        assert session.get(Job, job_id).status == JobStatus.canceled
        assert session.get(Summary, summary_id).content == "Teil"

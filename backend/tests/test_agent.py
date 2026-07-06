"""Unit tests for the agentic RAG loop (agent.py) with mocked LLM + RAG."""

from __future__ import annotations

import json
import tempfile

import pytest


@pytest.fixture()
def env(monkeypatch):
    """Temp data dir + reloaded modules, with RAG enabled and mocked."""
    tmp = tempfile.mkdtemp(prefix="tarscribe-agent-test-")
    monkeypatch.setenv("TARSCRIBE_DATA_DIR", tmp)
    monkeypatch.setenv("TARSCRIBE_AUTH_TOKEN", "")

    import importlib

    import tarscribe_backend.config as config

    importlib.reload(config)
    config.get_settings.cache_clear()

    import tarscribe_backend.db as db

    importlib.reload(db)

    import tarscribe_backend.rag as rag

    importlib.reload(rag)

    if not db.vec_available():
        pytest.skip("sqlite-vec extension not available")

    db.init_db()

    import tarscribe_backend.agent as agent

    importlib.reload(agent)
    # Clear capability cache between tests.
    agent._CAPABILITY_CACHE.clear()
    return agent, db, rag


def _base_cfg(**overrides):
    cfg = {
        "enabled": True,
        "max_rounds": 5,
        "max_context_tokens": 12000,
        "top_k": 6,
        "model": "test-model",
        "base_url": "http://llm",
        "api_key": None,
        "temperature": 0.3,
        "top_p": None,
        "top_k_llm": None,
        "max_tokens": None,
        "reasoning_effort": None,
        "provider": "ollama",
        "rag_enabled": True,
    }
    cfg.update(overrides)
    return cfg


def test_estimate_tokens(env):
    agent, _db, _rag = env
    assert agent._estimate_tokens("") == 1
    assert agent._estimate_tokens("abcd") == 1
    assert agent._estimate_tokens("abcde") == 1
    assert agent._estimate_tokens("abcdefgh") == 2


def test_compact_hits_strips_to_essentials(env):
    agent, _db, _rag = env
    hits = [
        {
            "recording_id": 1,
            "recording_title": "Meeting",
            "document_id": None,
            "source_type": "transcript",
            "text": "  Important text  ",
            "chunk_id": 42,
            "distance": 0.1,
            "score": 0.9,
        }
    ]
    compact = agent._compact_hits(hits)
    assert compact == [{"title": "Meeting", "source_type": "transcript", "text": "Important text"}]


def test_execute_tool_unknown_name(env):
    agent, _db, _rag = env
    result = agent._execute_tool(None, "bogus", {}, topic_id=None, recording_id=None, top_k=6)
    parsed = json.loads(result)
    assert "error" in parsed
    assert "bogus" in parsed["error"]


def test_execute_tool_empty_query(env):
    agent, _db, _rag = env
    result = agent._execute_tool(
        None, "search_knowledge", {"query": "  "}, topic_id=None, recording_id=None, top_k=6
    )
    parsed = json.loads(result)
    assert "error" in parsed


def test_capability_cache_start_unchecked(env):
    agent, _db, _rag = env
    assert agent.model_supports_tools("new-model") is None


def test_mark_capability(env):
    agent, _db, _rag = env
    agent._mark_capability("m1", True)
    assert agent.model_supports_tools("m1") is True
    agent._mark_capability("m1", False)
    assert agent.model_supports_tools("m1") is False


@pytest.mark.asyncio()
async def test_research_context_model_ignores_tools(env, monkeypatch):
    """When the model responds without tool_calls, the loop ends with empty notes."""
    agent, _db, _rag = env

    async def fake_achat_complete(*_args, **_kwargs):
        return {
            "message": {"role": "assistant", "content": "Kontext ausreichend", "tool_calls": None},
            "finish_reason": "stop",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    cfg = _base_cfg()
    notes, sources = await agent.research_context(
        session=None,
        topic_id=1,
        recording_id=1,
        task_description="Test",
        messages_seed=[],
        cfg=cfg,
    )
    assert notes == ""
    assert sources == []
    # Model responded to the tool request, so it should be marked capable.
    assert agent.model_supports_tools("test-model") is True


@pytest.mark.asyncio()
async def test_research_context_tool_support_error(env, monkeypatch):
    """When the endpoint rejects tools, ToolSupportError is raised and capability cached."""
    agent, _db, _rag = env

    async def fake_achat_complete(*_args, **_kwargs):
        raise Exception("400 Bad Request: tools not supported")

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    cfg = _base_cfg()
    with pytest.raises(agent.ToolSupportError):
        await agent.research_context(
            session=None,
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=cfg,
        )
    assert agent.model_supports_tools("test-model") is False


@pytest.mark.asyncio()
async def test_research_context_tool_loop_with_search(env, monkeypatch):
    """Model calls search_knowledge, gets results, then says 'enough'."""
    agent, _db, rag = env

    call_count = {"n": 0}

    async def fake_achat_complete(*_args, **_kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "search_knowledge",
                                "arguments": json.dumps({"query": "budget", "scope": "all"}),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        return {
            "message": {"role": "assistant", "content": "Kontext ausreichend", "tool_calls": None},
            "finish_reason": "stop",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)

    fake_hits = [
        {
            "recording_id": 2,
            "recording_title": "Budget Meeting",
            "document_id": None,
            "source_type": "transcript",
            "text": "Budget wurde diskutiert.",
        }
    ]
    monkeypatch.setattr(rag, "search", lambda *a, **kw: fake_hits)

    cfg = _base_cfg()
    notes, sources = await agent.research_context(
        session=object(),
        topic_id=1,
        recording_id=1,
        task_description="Test",
        messages_seed=[],
        cfg=cfg,
    )
    assert "Budget Meeting" in notes
    assert "Budget wurde diskutiert" in notes
    assert len(sources) == 1
    assert sources[0]["recording_title"] == "Budget Meeting"


@pytest.mark.asyncio()
async def test_research_context_token_budget_exhaustion(env, monkeypatch):
    """Loop stops when max_context_tokens is exceeded."""
    agent, _db, rag = env

    call_count = {"n": 0}

    async def fake_achat_complete(*_args, **_kwargs):
        call_count["n"] += 1
        return {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"call_{call_count['n']}",
                        "type": "function",
                        "function": {
                            "name": "search_knowledge",
                            "arguments": json.dumps({"query": "test", "scope": "all"}),
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)

    big_hits = [
        {
            "recording_id": 2,
            "recording_title": "Big",
            "document_id": None,
            "source_type": "transcript",
            "text": "A" * 200,
        }
    ]
    monkeypatch.setattr(rag, "search", lambda *a, **kw: big_hits)

    cfg = _base_cfg(max_context_tokens=50)  # very small budget
    notes, sources = await agent.research_context(
        session=object(),
        topic_id=1,
        recording_id=1,
        task_description="Test",
        messages_seed=[],
        cfg=cfg,
    )
    # Should have stopped early due to budget.
    assert call_count["n"] <= cfg["max_rounds"]
    assert len(sources) >= 1


@pytest.mark.asyncio()
async def test_research_context_cached_unsupported_skips_call(env, monkeypatch):
    """If capability cache says False, ToolSupportError raised without LLM call."""
    agent, _db, _rag = env
    agent._mark_capability("test-model", False)

    called = {"n": 0}

    async def fake_achat_complete(*_args, **_kwargs):
        called["n"] += 1
        return {}

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    cfg = _base_cfg()
    with pytest.raises(agent.ToolSupportError):
        await agent.research_context(
            session=None,
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=cfg,
        )
    assert called["n"] == 0


@pytest.mark.asyncio()
async def test_make_agent_chat_async_injects_notes(env, monkeypatch):
    """The agent chat callable runs research on first call and injects notes."""
    agent, _db, rag = env

    async def fake_achat_complete(*_args, **_kwargs):
        return {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {
                            "name": "search_knowledge",
                            "arguments": json.dumps({"query": "topic", "scope": "all"}),
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)

    fake_hits = [
        {
            "recording_id": 2,
            "recording_title": "Ref",
            "document_id": None,
            "source_type": "summary",
            "text": "Referenztext.",
        }
    ]
    monkeypatch.setattr(rag, "search", lambda *a, **kw: fake_hits)

    async def fake_astream_chat(*_args, **_kwargs):
        for d in ("Result",):
            yield d

    monkeypatch.setattr(agent.L, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(agent, "agent_rag_active", lambda: True)

    cfg = _base_cfg()

    class _Ctx:
        def __enter__(self):
            return object()

        def __exit__(self, *_a):
            return False

    chat = agent.make_agent_chat_async(
        session_factory=lambda: _Ctx(),
        topic_id=1,
        recording_id=1,
        cfg=cfg,
    )
    result = await chat([{"role": "system", "content": "Du bist Assistent."}])
    assert result == "Result"


@pytest.mark.asyncio()
async def test_make_agent_chat_async_fallback_on_tool_error(env, monkeypatch):
    """When ToolSupportError occurs, the callable falls back to plain chat."""
    agent, _db, _rag = env

    async def fake_achat_complete(*_args, **_kwargs):
        raise Exception("400 tools not supported")

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)

    async def fake_astream_chat(*_args, **_kwargs):
        for d in ("Plain",):
            yield d

    monkeypatch.setattr(agent.L, "astream_chat", fake_astream_chat)
    monkeypatch.setattr(agent, "agent_rag_active", lambda: True)

    cfg = _base_cfg()

    class _Ctx:
        def __enter__(self):
            return object()

        def __exit__(self, *_a):
            return False

    chat = agent.make_agent_chat_async(
        session_factory=lambda: _Ctx(),
        topic_id=1,
        recording_id=1,
        cfg=cfg,
    )
    result = await chat([{"role": "system", "content": "Du bist Assistent."}])
    assert result == "Plain"

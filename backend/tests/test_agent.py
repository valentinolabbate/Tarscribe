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
        "knowledge_search_enabled": True,
        "web_search_enabled": False,
    }
    cfg.update(overrides)
    return cfg


def test_estimate_tokens(env):
    agent, _db, _rag = env
    assert agent._estimate_tokens("") == 1
    assert agent._estimate_tokens("abcd") == 1
    assert agent._estimate_tokens("abcde") == 1
    assert agent._estimate_tokens("abcdefgh") == 2


def test_compact_hits_preserves_source_metadata(env):
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
    assert compact == [
        {
            "title": "Meeting",
            "recording_id": 1,
            "topic_id": None,
            "document_id": None,
            "source_type": "transcript",
                "start_sec": None,
                "end_sec": None,
                "speaker": None,
                "source_url": None,
                "text": "Important text",
            }
        ]


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


@pytest.mark.parametrize(
    ("knowledge", "web", "expected_tools", "active"),
    [
        (True, False, ["search_knowledge"], True),
        (False, True, ["search_web"], True),
        (True, True, ["search_knowledge", "search_web"], True),
        (False, False, [], False),
    ],
)
def test_research_channels_are_independently_configurable(
    env, knowledge, web, expected_tools, active
):
    agent, _db, _rag = env
    cfg = _base_cfg(
        knowledge_search_enabled=knowledge,
        web_search_enabled=web,
    )
    names = [tool["function"]["name"] for tool in agent._research_tools(cfg)]
    assert names == expected_tools
    assert agent.research_active(cfg) is active


def test_agent_config_keeps_web_active_when_rag_is_unavailable(env, monkeypatch):
    agent, _db, rag = env
    monkeypatch.setattr(rag, "rag_enabled", lambda: False)
    monkeypatch.setattr(
        agent.L,
        "get_llm_config",
        lambda _use_case: {
            "model": "web-model",
            "base_url": "http://llm",
            "agent_mode": True,
            "web_search": True,
        },
    )

    cfg = agent.get_agent_rag_config("summaries")

    assert cfg["knowledge_search_enabled"] is False
    assert cfg["web_search_enabled"] is True
    assert cfg["enabled"] is True
    assert agent.research_active(cfg) is True


def test_research_policy_follows_template_and_requires_enabled_channels(env):
    agent, _db, _rag = env
    template = "VORLAGE: Antworte nur aus dem Transkript und verwende keine Werkzeuge."
    messages = agent._research_messages(
        task_description="Zusammenfassung erstellen",
        messages_seed=[
            {"role": "system", "content": template},
            {"role": "user", "content": "Transkriptinhalt"},
        ],
        cfg=_base_cfg(web_search_enabled=True),
    )
    system = messages[0]["content"]
    assert system.index(template) < system.index("VERBINDLICHE RECHERCHE-VORGABE")
    assert "MUSST search_knowledge mindestens einmal" in system
    assert "MUSST search_web mindestens einmal" in system
    assert "search_knowledge, search_web" in messages[1]["content"]


@pytest.mark.asyncio()
async def test_research_context_model_ignores_tools(env, monkeypatch):
    """A model may not silently finish before using an enabled research channel."""
    agent, _db, _rag = env
    observed_messages: list[list[dict]] = []

    async def fake_achat_complete(messages, *_args, **_kwargs):
        observed_messages.append([dict(message) for message in messages])
        return {
            "message": {"role": "assistant", "content": "Kontext ausreichend", "tool_calls": None},
            "finish_reason": "stop",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    cfg = _base_cfg(max_rounds=3)
    with pytest.raises(agent.ToolSupportError, match="nicht alle aktivierten"):
        await agent.research_context(
            session=None,
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=cfg,
        )
    assert len(observed_messages) == 3
    assert "search_knowledge" in observed_messages[1][-1]["content"]
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
async def test_research_context_exposes_web_search_when_enabled(env, monkeypatch):
    agent, _db, _rag = env
    observed_tools: list[str] = []
    call_count = {"n": 0}

    async def fake_achat_complete(*_args, **kwargs):
        observed_tools[:] = [tool["function"]["name"] for tool in kwargs["tools"]]
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_web",
                            "type": "function",
                            "function": {
                                "name": "search_web",
                                "arguments": json.dumps({"query": "aktuelle norm", "max_results": 2}),
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

    class Result:
        title = "Norm Update"
        url = "https://example.com/norm"
        snippet = "Neue Fassung."
        text = "Neue Fassung mit wichtigen Details."

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    monkeypatch.setattr(agent, "search_web", lambda *_a, **_kw: [Result()])

    cfg = _base_cfg(
        rag_enabled=False,
        knowledge_search_enabled=False,
        web_search_enabled=True,
    )
    notes, sources = await agent.research_context(
        session=object(),
        topic_id=1,
        recording_id=1,
        task_description="Test",
        messages_seed=[],
        cfg=cfg,
    )
    assert observed_tools == ["search_web"]
    assert "Norm Update" in notes
    assert sources == [
        {
            "recording_id": None,
            "recording_title": "Norm Update",
            "topic_id": None,
            "document_id": None,
            "source_type": "web",
            "source_url": "https://example.com/norm",
            "start_sec": None,
            "end_sec": None,
            "speaker": None,
            "text": "Neue Fassung mit wichtigen Details.",
        }
    ]


@pytest.mark.asyncio()
async def test_research_context_reminds_model_to_use_second_enabled_channel(env, monkeypatch):
    agent, _db, rag = env
    call_count = {"n": 0}
    reminders: list[str] = []
    tool_choices: list[str] = []
    requested_tools: list[list[str]] = []

    async def fake_achat_complete(messages, *_args, **kwargs):
        call_count["n"] += 1
        tool_choices.append(kwargs["tool_choice"])
        requested_tools.append([tool["function"]["name"] for tool in kwargs["tools"]])
        if messages and messages[-1].get("role") == "user":
            reminders.append(messages[-1].get("content", ""))
        if call_count["n"] == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "knowledge",
                            "type": "function",
                            "function": {
                                "name": "search_knowledge",
                                "arguments": json.dumps({"query": "interne fakten", "scope": "all"}),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        if call_count["n"] == 2:
            return {
                "message": {
                    "role": "assistant",
                    "content": "Kontext ausreichend",
                    "tool_calls": None,
                },
                "finish_reason": "stop",
            }
        if call_count["n"] == 3:
            return {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "web",
                            "type": "function",
                            "function": {
                                "name": "search_web",
                                "arguments": json.dumps({"query": "externe fakten"}),
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

    class Result:
        title = "Externe Quelle"
        url = "https://example.com/source"
        snippet = "Externer Kontext."
        text = "Externer Kontext."

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)
    monkeypatch.setattr(
        rag,
        "search",
        lambda *_a, **_kw: [
            {
                "recording_id": 2,
                "recording_title": "Interne Quelle",
                "source_type": "transcript",
                "text": "Interner Kontext.",
            }
        ],
    )
    monkeypatch.setattr(agent, "search_web", lambda *_a, **_kw: [Result()])

    notes, sources = await agent.research_context(
        session=object(),
        topic_id=1,
        recording_id=1,
        task_description="Test",
        messages_seed=[],
        cfg=_base_cfg(web_search_enabled=True),
    )

    assert call_count["n"] == 4
    assert tool_choices == ["required", "required", "required", "auto"]
    assert requested_tools == [
        ["search_knowledge"],
        ["search_web"],
        ["search_web"],
        ["search_knowledge", "search_web"],
    ]
    assert any("search_web" in reminder for reminder in reminders)
    assert "Interner Kontext" in notes
    assert "Externer Kontext" in notes
    assert {source["source_type"] for source in sources} == {"transcript", "web"}


@pytest.mark.asyncio()
async def test_research_context_rejects_partial_channel_use(env, monkeypatch):
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
                            "id": "knowledge-only",
                            "type": "function",
                            "function": {
                                "name": "search_knowledge",
                                "arguments": json.dumps({"query": "intern", "scope": "all"}),
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
    monkeypatch.setattr(rag, "search", lambda *_args, **_kwargs: [])

    with pytest.raises(agent.ToolSupportError, match="search_web"):
        await agent.research_context(
            session=object(),
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=_base_cfg(max_rounds=2, web_search_enabled=True),
        )


@pytest.mark.asyncio()
async def test_research_context_rejects_malformed_tool_arguments(env, monkeypatch):
    agent, _db, _rag = env

    async def fake_achat_complete(*_args, **_kwargs):
        return {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "malformed",
                        "type": "function",
                        "function": {
                            "name": "search_knowledge",
                            "arguments": "{not-json",
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }

    monkeypatch.setattr(agent.L, "achat_complete", fake_achat_complete)

    with pytest.raises(agent.ToolSupportError, match="search_knowledge"):
        await agent.research_context(
            session=object(),
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=_base_cfg(max_rounds=1),
        )


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


def test_research_context_sync_uses_web_without_rag(env, monkeypatch):
    agent, _db, _rag = env
    captured: dict = {}
    call_count = {"n": 0}

    def fake_chat_complete(messages, *_args, **kwargs):
        captured["system"] = messages[0]["content"]
        captured["tools"] = [tool["function"]["name"] for tool in kwargs["tools"]]
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "web-sync",
                            "type": "function",
                            "function": {
                                "name": "search_web",
                                "arguments": json.dumps({"query": "aktuelle daten"}),
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

    class Result:
        title = "Aktuelle Daten"
        url = "https://example.com/data"
        snippet = "Stand heute."
        text = "Stand heute."

    monkeypatch.setattr(agent.L, "chat_complete", fake_chat_complete)
    monkeypatch.setattr(agent, "search_web", lambda *_a, **_kw: [Result()])
    cfg = _base_cfg(
        rag_enabled=False,
        knowledge_search_enabled=False,
        web_search_enabled=True,
    )

    notes, sources = agent.research_context_sync(
        session=object(),
        topic_id=None,
        recording_id=None,
        task_description="Wochen-Digest erstellen",
        messages_seed=[{"role": "system", "content": "Digest-Vorlage"}],
        cfg=cfg,
    )

    assert captured["tools"] == ["search_web"]
    assert captured["system"].index("Digest-Vorlage") < captured["system"].index(
        "VERBINDLICHE RECHERCHE-VORGABE"
    )
    assert "Aktuelle Daten" in notes
    assert sources[0]["source_type"] == "web"


def test_research_context_sync_rejects_empty_tool_query(env, monkeypatch):
    agent, _db, _rag = env

    def fake_chat_complete(*_args, **_kwargs):
        return {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "empty-sync",
                        "type": "function",
                        "function": {
                            "name": "search_knowledge",
                            "arguments": json.dumps({}),
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }

    monkeypatch.setattr(agent.L, "chat_complete", fake_chat_complete)

    with pytest.raises(agent.ToolSupportError, match="search_knowledge"):
        agent.research_context_sync(
            session=object(),
            topic_id=1,
            recording_id=1,
            task_description="Test",
            messages_seed=[],
            cfg=_base_cfg(max_rounds=1),
        )


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

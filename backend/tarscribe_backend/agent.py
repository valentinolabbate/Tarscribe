"""Agentic RAG loop: lets the LLM iteratively search the internal knowledge
base via native OpenAI tool calls before generating summaries, action items,
chapters, dictation or digests.

When ``agent_rag_enabled`` is on (and RAG is available and the chat model
supports tools), the LLM receives a ``search_knowledge`` tool and may call it
multiple times with different queries until it has gathered enough context.
Falls back to the existing one-shot ``rag.retrieve_topic_knowledge``
enrichment when the model lacks tool support.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from . import llm as L
from . import rag as R
from .settings_store import load_prefs

log = logging.getLogger(__name__)

# --- capability cache: model -> supports OpenAI tools ----------------------
_CAPABILITY_CACHE: dict[str, bool] = {}


def model_supports_tools(model: str | None) -> bool | None:
    """Return cached capability for a model, or ``None`` if not yet probed."""
    if not model:
        return None
    return _CAPABILITY_CACHE.get(model)


def _mark_capability(model: str | None, supported: bool) -> None:
    if model:
        _CAPABILITY_CACHE[model] = supported


class ToolSupportError(Exception):
    """Raised when the chat endpoint rejects ``tools`` (model lacks support)."""


# --- configuration ---------------------------------------------------------


def get_agent_rag_config() -> dict:
    """Merge agent_rag prefs with the chat-LLM config and RAG availability."""
    prefs = load_prefs()
    agent = prefs.get("agent_rag") or {}
    llm_cfg = L.get_llm_config()
    return {
        "enabled": bool(prefs.get("agent_rag_enabled")),
        "max_rounds": int(agent.get("max_rounds") or 5),
        "max_context_tokens": int(agent.get("max_context_tokens") or 12000),
        "top_k": int(agent.get("top_k") or 6),
        "model": llm_cfg.get("model"),
        "base_url": llm_cfg.get("base_url"),
        "api_key": llm_cfg.get("api_key"),
        "temperature": llm_cfg.get("temperature", 0.3),
        "top_p": llm_cfg.get("top_p"),
        "top_k_llm": llm_cfg.get("top_k"),
        "max_tokens": llm_cfg.get("max_tokens"),
        "reasoning_effort": llm_cfg.get("reasoning_effort"),
        "provider": llm_cfg.get("provider"),
        "rag_enabled": R.rag_enabled(),
    }


def agent_rag_active() -> bool:
    """True when agentic RAG is enabled and RAG backend is available."""
    cfg = get_agent_rag_config()
    return bool(cfg["enabled"] and cfg["rag_enabled"] and cfg["model"])


# --- tool definition (OpenAI JSON schema) ----------------------------------

SEARCH_KNOWLEDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "search_knowledge",
        "description": (
            "Durchsuche die Tarscribe-Wissensbasis (Transkripte, "
            "Zusammenfassungen, Dokumente) nach relevantem Kontext. "
            "Rufe dies mehrfach mit unterschiedlichen Queries ab, bis "
            "du genug Kontext gesammelt hast."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Suchanfrage — natürliche Sprache oder Schlagworte.",
                },
                "scope": {
                    "type": "string",
                    "enum": ["topic", "recording", "all"],
                    "description": "Suchbereich: Themenbereich, aktuelles Recording oder alles.",
                    "default": "topic",
                },
            },
            "required": ["query"],
        },
    },
}


_RESEARCH_SYSTEM = (
    "Du bist ein Recherche-Assistent. Verwende das Werkzeug search_knowledge, "
    "um die interne Wissensbasis nach relevantem Kontext zur gegebenen Aufgabe "
    "zu durchsuchen. Stelle gezielte Queries mit unterschiedlichen "
    "Schlagworten. Wenn du genug Kontext gesammelt hast oder keine weiteren "
    "Treffer mehr relevant sind, antworte ohne Werkzeugaufruf mit einer "
    "kurzen Bestätigung (z.B. 'Kontext ausreichend')."
)


# --- helpers ---------------------------------------------------------------


def _estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token for mixed German/English)."""
    return max(1, len(text) // 4)


def _compact_hits(hits: list[dict]) -> list[dict]:
    """Reduce hit dicts to token-friendly essentials for the tool response."""
    compact: list[dict] = []
    for h in hits:
        compact.append(
            {
                "title": h.get("recording_title") or "Quelle",
                "source_type": h.get("source_type"),
                "text": (h.get("text") or "").strip(),
            }
        )
    return compact


def _execute_tool(
    session: Any,
    tool_name: str,
    arguments: dict,
    *,
    topic_id: int | None,
    recording_id: int | None,
    top_k: int,
) -> str:
    """Dispatch a model-requested tool call to the RAG backend."""
    if tool_name != "search_knowledge":
        return json.dumps({"error": f"Unbekanntes Werkzeug: {tool_name}"}, ensure_ascii=False)
    query = arguments.get("query") or ""
    scope = arguments.get("scope") or "topic"
    if not query.strip():
        return json.dumps({"error": "Leere Suchanfrage."}, ensure_ascii=False)
    try:
        if scope == "recording" and recording_id:
            hits = R.search(session, query, top_k=top_k, recording_id=recording_id)
        elif scope == "all":
            hits = R.search(session, query, top_k=top_k)
        else:
            if topic_id is None:
                hits = R.search(session, query, top_k=top_k)
            else:
                hits = R.retrieve_topic_knowledge(
                    session,
                    query,
                    topic_id=topic_id,
                    exclude_recording_id=recording_id,
                    top_k=top_k,
                )
        return json.dumps(_compact_hits(hits), ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        log.warning("search_knowledge tool failed: %s", exc)
        return json.dumps({"error": f"Suche fehlgeschlagen: {exc}"}, ensure_ascii=False)


def _format_research_notes(sources: list[dict]) -> str:
    """Render collected sources into a labeled, numbered context block."""
    lines: list[str] = []
    for i, src in enumerate(sources, 1):
        title = src.get("recording_title") or src.get("title") or "Quelle"
        type_label = src.get("source_type") or ""
        text = (src.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"[{i}] {title} ({type_label}):\n{text}")
    return "\n\n".join(lines)


def _hits_to_sources(hits: list[dict]) -> list[dict]:
    """Convert compact hits back to source metadata for _save_summary_sources."""
    return [
        {
            "recording_id": h.get("recording_id"),
            "recording_title": h.get("title") or h.get("recording_title"),
            "document_id": h.get("document_id"),
            "source_type": h.get("source_type"),
            "text": h.get("text"),
        }
        for h in hits
    ]


# --- core loop (async) -----------------------------------------------------


async def research_context(
    *,
    session: Any,
    topic_id: int | None,
    recording_id: int | None,
    task_description: str,
    messages_seed: list[dict],
    cfg: dict,
    job_id: int | None = None,
    raise_if_canceled: Callable[[int], None] | None = None,
    broadcast_fn: Callable[[dict], None] | None = None,
) -> tuple[str, list[dict]]:
    """Run the agentic retrieval loop.

    Returns ``(research_notes, sources)`` where *research_notes* is a formatted
    context block ready to inject into the final prompt, and *sources* is the
    metadata list for persistence.

    Raises ``ToolSupportError`` when the endpoint rejects ``tools``, so the
    caller can fall back to one-shot RAG enrichment.
    """
    model = cfg["model"]
    max_rounds = cfg.get("max_rounds", 5)
    max_context_tokens = cfg.get("max_context_tokens", 12000)
    top_k = cfg.get("top_k", 6)

    # Short-circuit if we already know this model lacks tool support.
    cached = model_supports_tools(model)
    if cached is False:
        raise ToolSupportError(f"Modell '{model}' unterstützt keine Tools (Cache).")

    seed_user = ""
    for m in messages_seed:
        if m.get("role") == "user":
            seed_user = m.get("content", "")
            break
    seed_system = next((m.get("content", "") for m in messages_seed if m.get("role") == "system"), "")

    research_user = (
        f"Aufgabe: {task_description}\n\n"
        f"{seed_user}\n\n"
        "Recherchiere relevanten Kontext aus der Wissensbasis, der dir bei "
        "dieser Aufgabe hilft. Verwende search_knowledge mit gezielten, "
        "unterschiedlichen Queries. Wenn du genug hast oder keine weiteren "
        'Treffer relevant sind, antworte ohne Werkzeugaufruf mit "Kontext ausreichend".'
    )
    research_system = f"{_RESEARCH_SYSTEM}\n\n{seed_system}".strip()

    messages: list[dict] = [
        {"role": "system", "content": research_system},
        {"role": "user", "content": research_user},
    ]

    accumulated_sources: list[dict] = []
    accumulated_tokens = 0
    tools_tried = False

    for round_idx in range(max_rounds):
        if raise_if_canceled and job_id is not None:
            raise_if_canceled(job_id)

        try:
            resp = await L.achat_complete(
                messages,
                model=model,
                base_url=cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k_llm"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=cfg.get("reasoning_effort"),
                provider=cfg.get("provider"),
                tools=[SEARCH_KNOWLEDGE_TOOL],
                tool_choice="auto",
            )
        except Exception as exc:
            msg_lower = str(exc).lower()
            if (
                "tool" in msg_lower
                or "function" in msg_lower
                or "400" in msg_lower
                or "422" in msg_lower
            ):
                _mark_capability(model, False)
                raise ToolSupportError(f"Endpoint lehnt tools ab: {exc}") from exc
            raise

        tools_tried = True
        _mark_capability(model, True)

        msg = resp["message"]
        # Normalise the assistant message so it round-trips cleanly.
        assistant_msg: dict = {"role": "assistant"}
        if msg.get("content"):
            assistant_msg["content"] = msg["content"]
        if msg.get("tool_calls"):
            assistant_msg["tool_calls"] = msg["tool_calls"]
        messages.append(assistant_msg)

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            # Model decided it has enough context (or none is needed).
            break

        budget_exhausted = False
        for tc in tool_calls:
            if raise_if_canceled and job_id is not None:
                raise_if_canceled(job_id)

            fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
            tool_name = fn.get("name", "")
            raw_args = fn.get("arguments", "{}")
            try:
                arguments = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                arguments = {}

            if broadcast_fn:
                broadcast_fn({
                    "phase": "tool_call",
                    "round": round_idx,
                    "tool": tool_name,
                    "query": arguments.get("query", ""),
                    "scope": arguments.get("scope", "topic"),
                })

            tool_result = _execute_tool(
                session,
                tool_name,
                arguments,
                topic_id=topic_id,
                recording_id=recording_id,
                top_k=top_k,
            )

            try:
                parsed_result = json.loads(tool_result)
                hit_count = len(parsed_result) if isinstance(parsed_result, list) else 0
            except json.JSONDecodeError:
                hit_count = 0

            if broadcast_fn:
                broadcast_fn({
                    "phase": "tool_result",
                    "round": round_idx,
                    "tool": tool_name,
                    "hits": hit_count,
                })

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": tool_result,
                }
            )

            try:
                parsed = json.loads(tool_result)
                if isinstance(parsed, list):
                    for hit in parsed:
                        accumulated_sources.append(hit)
            except json.JSONDecodeError:
                pass

            accumulated_tokens += _estimate_tokens(tool_result)
            if accumulated_tokens >= max_context_tokens:
                budget_exhausted = True
                # Inform the model that the budget is exhausted, then break.
                messages.append(
                    {
                        "role": "user",
                        "content": "Kontext-Budget erreicht. Bitte fasse die recherchierten Ergebnisse zusammen.",
                    }
                )
                break

        if budget_exhausted:
            break

    # If the model never tried tools, it may not support them silently.
    if not tools_tried:
        # This shouldn't happen since we always send tools on round 0,
        # but guard anyway.
        raise ToolSupportError("Modell hat nicht auf Tools reagiert.")

    # Deduplicate sources by text content.
    seen_texts: set[str] = set()
    deduped: list[dict] = []
    for src in accumulated_sources:
        t = (src.get("text") or "").strip()
        if t and t not in seen_texts:
            seen_texts.add(t)
            deduped.append(src)

    research_notes = _format_research_notes(deduped)
    sources = _hits_to_sources(deduped)
    if broadcast_fn:
        broadcast_fn({"phase": "done", "round": round_idx, "sources": len(sources)})
    return research_notes, sources


# --- sync variant (for digest) ---------------------------------------------


def research_context_sync(
    *,
    session: Any,
    topic_id: int | None,
    recording_id: int | None,
    task_description: str,
    messages_seed: list[dict],
    cfg: dict,
    broadcast_fn: Callable[[dict], None] | None = None,
) -> tuple[str, list[dict]]:
    """Sync version of ``research_context`` for non-async callers (digest)."""
    model = cfg["model"]
    cached = model_supports_tools(model)
    if cached is False:
        raise ToolSupportError(f"Modell '{model}' unterstützt keine Tools (Cache).")

    max_rounds = cfg.get("max_rounds", 5)
    max_context_tokens = cfg.get("max_context_tokens", 12000)
    top_k = cfg.get("top_k", 6)

    seed_user = ""
    for m in messages_seed:
        if m.get("role") == "user":
            seed_user = m.get("content", "")
            break
    seed_system = next((m.get("content", "") for m in messages_seed if m.get("role") == "system"), "")

    research_user = (
        f"Aufgabe: {task_description}\n\n"
        f"{seed_user}\n\n"
        "Recherchiere relevanten Kontext aus der Wissensbasis, der dir bei "
        "dieser Aufgabe hilft. Verwende search_knowledge mit gezielten, "
        "unterschiedlichen Queries. Wenn du genug hast oder keine weiteren "
        'Treffer relevant sind, antworte ohne Werkzeugaufruf mit "Kontext ausreichend".'
    )
    research_system = f"{_RESEARCH_SYSTEM}\n\n{seed_system}".strip()

    messages: list[dict] = [
        {"role": "system", "content": research_system},
        {"role": "user", "content": research_user},
    ]

    accumulated_sources: list[dict] = []
    accumulated_tokens = 0
    tools_tried = False

    for round_idx in range(max_rounds):
        try:
            resp = L.chat_complete(
                messages,
                model=model,
                base_url=cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k_llm"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=cfg.get("reasoning_effort"),
                provider=cfg.get("provider"),
                tools=[SEARCH_KNOWLEDGE_TOOL],
                tool_choice="auto",
            )
        except Exception as exc:
            msg_lower = str(exc).lower()
            if (
                "tool" in msg_lower
                or "function" in msg_lower
                or "400" in msg_lower
                or "422" in msg_lower
            ):
                _mark_capability(model, False)
                raise ToolSupportError(f"Endpoint lehnt tools ab: {exc}") from exc
            raise

        tools_tried = True
        _mark_capability(model, True)

        msg = resp["message"]
        assistant_msg: dict = {"role": "assistant"}
        if msg.get("content"):
            assistant_msg["content"] = msg["content"]
        if msg.get("tool_calls"):
            assistant_msg["tool_calls"] = msg["tool_calls"]
        messages.append(assistant_msg)

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            break

        budget_exhausted = False
        for tc in tool_calls:
            fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
            tool_name = fn.get("name", "")
            raw_args = fn.get("arguments", "{}")
            try:
                arguments = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                arguments = {}

            if broadcast_fn:
                broadcast_fn({
                    "phase": "tool_call",
                    "round": round_idx,
                    "tool": tool_name,
                    "query": arguments.get("query", ""),
                    "scope": arguments.get("scope", "topic"),
                })

            tool_result = _execute_tool(
                session,
                tool_name,
                arguments,
                topic_id=topic_id,
                recording_id=recording_id,
                top_k=top_k,
            )

            try:
                parsed_result = json.loads(tool_result)
                hit_count = len(parsed_result) if isinstance(parsed_result, list) else 0
            except json.JSONDecodeError:
                hit_count = 0

            if broadcast_fn:
                broadcast_fn({
                    "phase": "tool_result",
                    "round": round_idx,
                    "tool": tool_name,
                    "hits": hit_count,
                })

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": tool_result,
                }
            )

            try:
                parsed = json.loads(tool_result)
                if isinstance(parsed, list):
                    for hit in parsed:
                        accumulated_sources.append(hit)
            except json.JSONDecodeError:
                pass

            accumulated_tokens += _estimate_tokens(tool_result)
            if accumulated_tokens >= max_context_tokens:
                budget_exhausted = True
                messages.append(
                    {
                        "role": "user",
                        "content": "Kontext-Budget erreicht. Bitte fasse die recherchierten Ergebnisse zusammen.",
                    }
                )
                break

        if budget_exhausted:
            break

    if not tools_tried:
        raise ToolSupportError("Modell hat nicht auf Tools reagiert.")

    seen_texts: set[str] = set()
    deduped: list[dict] = []
    for src in accumulated_sources:
        t = (src.get("text") or "").strip()
        if t and t not in seen_texts:
            seen_texts.add(t)
            deduped.append(src)

    research_notes = _format_research_notes(deduped)
    sources = _hits_to_sources(deduped)
    if broadcast_fn:
        broadcast_fn({"phase": "done", "round": round_idx, "sources": len(sources)})
    return research_notes, sources


# --- agent chat callable (for analysis.py functions) ----------------------

AsyncChat = Callable[[list[dict]], Awaitable[str]]


def make_agent_chat_async(
    *,
    session_factory: Callable[[], Any],
    topic_id: int | None,
    recording_id: int | None,
    cfg: dict,
    job_id: int | None = None,
    raise_if_canceled: Callable[[int], None] | None = None,
    broadcast_fn: Callable[[dict], None] | None = None,
) -> AsyncChat:
    """Build an ``AsyncChat`` callable that runs agentic research on first
    invocation, then injects the gathered context into every subsequent call.

    Falls back to a plain ``L.astream_chat`` drain (no tools) when the model
    lacks tool support or research yields no notes.
    """
    state: dict = {"research_done": False, "notes": "", "sources": []}

    async def _chat(messages: list[dict]) -> str:
        if not state["research_done"]:
            state["research_done"] = True
            if agent_rag_active():
                task_desc = "Analyse des Transkripts (Action Items / Kapitel / Diktat)"
                try:
                    with session_factory() as s:
                        notes, sources = await research_context(
                            session=s,
                            topic_id=topic_id,
                            recording_id=recording_id,
                            task_description=task_desc,
                            messages_seed=messages,
                            cfg=cfg,
                            job_id=job_id,
                            raise_if_canceled=raise_if_canceled,
                            broadcast_fn=broadcast_fn,
                        )
                    state["notes"] = notes
                    state["sources"] = sources
                except ToolSupportError:
                    state["notes"] = ""
                except Exception:  # noqa: BLE001
                    log.exception("Agentic research failed; falling back to plain chat")
                    state["notes"] = ""

        # Inject research notes into the system prompt if present.
        if state["notes"]:
            messages = list(messages)
            if messages and messages[0].get("role") == "system":
                messages[0] = {
                    **messages[0],
                    "content": messages[0]["content"]
                    + "\n\n--- Recherchierter Kontext ---\n"
                    + state["notes"],
                }
            else:
                messages.insert(
                    0,
                    {
                        "role": "system",
                        "content": "--- Recherchierter Kontext ---\n" + state["notes"],
                    },
                )

        # Final call — stream and accumulate (no tools).
        acc: list[str] = []
        async for delta in L.astream_chat(
            messages,
            model=cfg["model"],
            base_url=cfg["base_url"],
            temperature=cfg.get("temperature", 0.3),
            top_p=cfg.get("top_p"),
            top_k=cfg.get("top_k_llm"),
            max_tokens=cfg.get("max_tokens"),
            api_key=cfg.get("api_key"),
            reasoning_effort=cfg.get("reasoning_effort"),
            provider=cfg.get("provider"),
        ):
            acc.append(delta)
        return "".join(acc)

    return _chat


def get_research_sources(chat: AsyncChat) -> list[dict]:
    """Extract research sources from an agent chat callable's state.

    Returns an empty list for plain (non-agent) chat callables.
    """
    # The state dict is a closure variable; access via __closure__.
    closure = getattr(chat, "__closure__", None)
    if not closure:
        return []
    for cell in closure:
        if isinstance(cell.cell_contents, dict) and "sources" in cell.cell_contents:
            return cell.cell_contents.get("sources", [])
    return []


# --- sync agent chat callable (for dictation) ------------------------------

Chat = Callable[[list[dict]], str]


def make_agent_chat_sync(
    *,
    session_factory: Callable[[], Any],
    topic_id: int | None,
    recording_id: int | None,
    cfg: dict,
    broadcast_fn: Callable[[dict], None] | None = None,
) -> Chat:
    """Sync version of ``make_agent_chat_async`` for non-async callers
    (dictation post-processing).
    """
    state: dict = {"research_done": False, "notes": "", "sources": []}

    def _chat(messages: list[dict]) -> str:
        if not state["research_done"]:
            state["research_done"] = True
            if agent_rag_active():
                task_desc = "Diktat-Analyse (Titel, Themenbereich, Aufgaben)"
                try:
                    with session_factory() as s:
                        notes, sources = research_context_sync(
                            session=s,
                            topic_id=topic_id,
                            recording_id=recording_id,
                            task_description=task_desc,
                            messages_seed=messages,
                            cfg=cfg,
                            broadcast_fn=broadcast_fn,
                        )
                    state["notes"] = notes
                    state["sources"] = sources
                except ToolSupportError:
                    state["notes"] = ""
                except Exception:  # noqa: BLE001
                    log.exception("Agentic research failed; falling back to plain chat")
                    state["notes"] = ""

        if state["notes"]:
            messages = list(messages)
            if messages and messages[0].get("role") == "system":
                messages[0] = {
                    **messages[0],
                    "content": messages[0]["content"]
                    + "\n\n--- Recherchierter Kontext ---\n"
                    + state["notes"],
                }
            else:
                messages.insert(
                    0,
                    {
                        "role": "system",
                        "content": "--- Recherchierter Kontext ---\n" + state["notes"],
                    },
                )

        return "".join(
            L.stream_chat(
                messages,
                model=cfg["model"],
                base_url=cfg["base_url"],
                temperature=cfg.get("temperature", 0.3),
                top_p=cfg.get("top_p"),
                top_k=cfg.get("top_k_llm"),
                max_tokens=cfg.get("max_tokens"),
                api_key=cfg.get("api_key"),
                reasoning_effort=cfg.get("reasoning_effort"),
                provider=cfg.get("provider"),
            )
        )

    return _chat

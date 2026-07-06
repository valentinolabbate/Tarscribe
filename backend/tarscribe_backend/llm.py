"""OpenAI-compatible chat client for configurable providers/endpoints.

The same /v1/models and /v1/chat/completions shape covers hosted providers,
self-hosted servers, and custom OpenAI-compatible endpoints.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from datetime import datetime

import httpx

from .settings_store import get_llm_api_key, load_prefs

# Rough char budget per LLM request before we switch to map-reduce chunking.
CHAR_BUDGET = 48_000


def get_llm_config() -> dict:
    llm = load_prefs().get("llm") or {}
    return {
        "base_url": (llm.get("base_url") or "http://localhost:11434/v1").rstrip("/"),
        "model": llm.get("model"),
        "provider": llm.get("provider") or "ollama",
        "api_key": get_llm_api_key(),
        "temperature": float(llm["temperature"]) if llm.get("temperature") is not None else 0.3,
        "top_p": float(llm["top_p"]) if llm.get("top_p") is not None else None,
        "top_k": int(llm["top_k"]) if llm.get("top_k") is not None else None,
        "max_tokens": int(llm["max_tokens"]) if llm.get("max_tokens") is not None else None,
        # Reasoning/"thinking" depth for capable models (minimal|low|medium|high);
        # None = don't send the param (model uses its default).
        "reasoning_effort": llm.get("reasoning_effort") or None,
    }


def _auth_headers(api_key: str | None) -> dict:
    """Bearer header for OpenAI-compatible providers that require an API key."""
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def list_models(base_url: str | None = None, api_key: str | None = None) -> list[str]:
    cfg = get_llm_config()
    base = (base_url or cfg["base_url"]).rstrip("/")
    # Explicit key wins (e.g. testing an unsaved key); otherwise use the stored one.
    key = api_key if api_key is not None else cfg["api_key"]
    r = httpx.get(f"{base}/models", headers=_auth_headers(key), timeout=8)
    r.raise_for_status()
    data = r.json().get("data", [])
    return [m.get("id") for m in data if m.get("id")]


def test_connection(base_url: str | None = None, api_key: str | None = None) -> dict:
    try:
        models = list_models(base_url, api_key)
        return {"ok": True, "models": models}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _chat_payload(
    messages: list[dict],
    model: str,
    temperature: float,
    top_p: float | None,
    top_k: int | None,
    max_tokens: int | None,
    reasoning_effort: str | None,
    provider: str | None,
    tools: list[dict] | None = None,
    tool_choice: str | dict | None = None,
    stream: bool = True,
) -> dict:
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    if top_p is not None:
        payload["top_p"] = top_p
    if top_k is not None:
        payload["top_k"] = top_k
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if reasoning_effort:
        if provider == "openrouter":
            payload["reasoning"] = {"effort": reasoning_effort}
        else:
            payload["reasoning_effort"] = reasoning_effort
    if tools is not None:
        payload["tools"] = tools
    if tool_choice is not None:
        payload["tool_choice"] = tool_choice
    return payload


def _parse_stream_line(line: str) -> str | None:
    if not line or not line.startswith("data:"):
        return None
    data = line[len("data:") :].strip()
    if data == "[DONE]":
        return None
    try:
        chunk = json.loads(data)
        return chunk["choices"][0]["delta"].get("content")
    except (json.JSONDecodeError, KeyError, IndexError):
        return None


def stream_chat(
    messages: list[dict],
    model: str,
    base_url: str,
    temperature: float = 0.3,
    top_p: float | None = None,
    top_k: int | None = None,
    max_tokens: int | None = None,
    api_key: str | None = None,
    reasoning_effort: str | None = None,
    provider: str | None = None,
) -> Iterator[str]:
    """Yield content deltas from a streaming chat completion."""
    payload = _chat_payload(
        messages,
        model,
        temperature,
        top_p,
        top_k,
        max_tokens,
        reasoning_effort,
        provider,
    )
    with httpx.stream(
        "POST",
        f"{base_url}/chat/completions",
        json=payload,
        headers=_auth_headers(api_key),
        timeout=None,
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if line.strip() == "data: [DONE]":
                break
            delta = _parse_stream_line(line)
            if delta:
                yield delta


async def astream_chat(
    messages: list[dict],
    model: str,
    base_url: str,
    temperature: float = 0.3,
    top_p: float | None = None,
    top_k: int | None = None,
    max_tokens: int | None = None,
    api_key: str | None = None,
    reasoning_effort: str | None = None,
    provider: str | None = None,
) -> AsyncIterator[str]:
    """Async variant used by background LLM jobs so cancellation closes HTTP streams."""
    payload = _chat_payload(
        messages,
        model,
        temperature,
        top_p,
        top_k,
        max_tokens,
        reasoning_effort,
        provider,
    )
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            json=payload,
            headers=_auth_headers(api_key),
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.strip() == "data: [DONE]":
                    break
                delta = _parse_stream_line(line)
                if delta:
                    yield delta


async def achat_complete(
    messages: list[dict],
    model: str,
    base_url: str,
    temperature: float = 0.3,
    top_p: float | None = None,
    top_k: int | None = None,
    max_tokens: int | None = None,
    api_key: str | None = None,
    reasoning_effort: str | None = None,
    provider: str | None = None,
    tools: list[dict] | None = None,
    tool_choice: str | dict | None = None,
    timeout: float | None = 300,
) -> dict:
    """Non-streaming async completion. Returns the full choice dict:
    {"message": {"role","content","tool_calls"}, "finish_reason"}.
    Used by the agentic RAG loop where we need the complete response
    (incl. tool_calls) in one shot rather than incremental deltas.
    """
    payload = _chat_payload(
        messages,
        model,
        temperature,
        top_p,
        top_k,
        max_tokens,
        reasoning_effort,
        provider,
        tools=tools,
        tool_choice=tool_choice,
        stream=False,
    )
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url}/chat/completions",
            json=payload,
            headers=_auth_headers(api_key),
        )
        r.raise_for_status()
        data = r.json()
    choices = data.get("choices") or []
    if not choices:
        return {"message": {"role": "assistant", "content": "", "tool_calls": None}, "finish_reason": None}
    choice = choices[0]
    return {
        "message": choice.get("message") or {"role": "assistant", "content": "", "tool_calls": None},
        "finish_reason": choice.get("finish_reason"),
    }


def chat_complete(
    messages: list[dict],
    model: str,
    base_url: str,
    temperature: float = 0.3,
    top_p: float | None = None,
    top_k: int | None = None,
    max_tokens: int | None = None,
    api_key: str | None = None,
    reasoning_effort: str | None = None,
    provider: str | None = None,
    tools: list[dict] | None = None,
    tool_choice: str | dict | None = None,
    timeout: float | None = 300,
) -> dict:
    """Sync non-streaming completion. Same return shape as ``achat_complete``.
    Used by sync callers (e.g. digest generation).
    """
    payload = _chat_payload(
        messages,
        model,
        temperature,
        top_p,
        top_k,
        max_tokens,
        reasoning_effort,
        provider,
        tools=tools,
        tool_choice=tool_choice,
        stream=False,
    )
    r = httpx.post(
        f"{base_url}/chat/completions",
        json=payload,
        headers=_auth_headers(api_key),
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    choices = data.get("choices") or []
    if not choices:
        return {"message": {"role": "assistant", "content": "", "tool_calls": None}, "finish_reason": None}
    choice = choices[0]
    return {
        "message": choice.get("message") or {"role": "assistant", "content": "", "tool_calls": None},
        "finish_reason": choice.get("finish_reason"),
    }


def render_template(template_str: str, context: dict[str, str]) -> str:
    out = template_str
    for key, value in context.items():
        out = out.replace("{{" + key + "}}", value)
    return out


def build_context(
    duration_sec: float,
    created_at,
    topic_name: str,
    transcript_text: str,
    speakers: list[str],
    recording_title: str = "",
) -> dict:
    dt = created_at or datetime.utcnow()
    title = (recording_title or "").strip() or "Aufnahme"
    return {
        "transcript": transcript_text,
        "recording_title": title,
        "speakers": ", ".join(speakers) if speakers else "unbekannt",
        "topic": topic_name or "",
        "duration": _fmt_dur(duration_sec),
        "date": dt.strftime("%d.%m.%Y"),       # für menschenlesbaren Text
        "date_iso": dt.strftime("%Y-%m-%d"),    # für Obsidian-Frontmatter (Dataview-kompatibel)
    }


def chunk_text(text: str, size: int = CHAR_BUDGET) -> list[str]:
    """Split text on paragraph/sentence boundaries into <= size chunks."""
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    buf = ""
    for para in text.split("\n"):
        if len(buf) + len(para) + 1 > size and buf:
            chunks.append(buf)
            buf = ""
        if len(para) > size:
            # Hard-split an over-long paragraph by sentence.
            for sent in para.replace(". ", ".\n").split("\n"):
                if len(buf) + len(sent) + 1 > size and buf:
                    chunks.append(buf)
                    buf = ""
                buf += sent + " "
        else:
            buf += para + "\n"
    if buf.strip():
        chunks.append(buf)
    return chunks


def _fmt_dur(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

import json

import pytest

import tarscribe_backend.llm as llm
from tarscribe_backend.llm import _ThinkingBlockFilter, strip_thinking_blocks


def test_strip_thinking_blocks_from_completed_and_unclosed_output():
    content = (
        "<think>Interne Analyse</think>\n"
        "# Zusammenfassung\n\nSichtbarer Inhalt.\n"
        "<think>Unvollständige interne Analyse"
    )

    assert strip_thinking_blocks(content) == "# Zusammenfassung\n\nSichtbarer Inhalt.\n"


def test_thinking_filter_handles_tags_split_across_stream_chunks():
    thinking_filter = _ThinkingBlockFilter()
    chunks = [
        "<thi",
        "nk>Interne ",
        "Analyse</th",
        "ink>\n# Zusammen",
        "fassung",
    ]

    visible = "".join(thinking_filter.feed(chunk) for chunk in chunks)
    visible += thinking_filter.finish()

    assert visible == "\n# Zusammenfassung"


def test_thinking_filter_preserves_normal_angle_brackets():
    thinking_filter = _ThinkingBlockFilter()

    visible = thinking_filter.feed("Ergebnis: 2 < 3 und fertig")
    visible += thinking_filter.finish()

    assert visible == "Ergebnis: 2 < 3 und fertig"


@pytest.mark.asyncio
async def test_async_chat_stream_never_yields_thinking_content(monkeypatch):
    lines = [
        "data: "
        + json.dumps({"choices": [{"delta": {"content": chunk}}]})
        for chunk in ("<thi", "nk>Intern", "</th", "ink>\n# Ergebnis")
    ]
    lines.append("data: [DONE]")

    class FakeResponse:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in lines:
                yield line

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(llm.httpx, "AsyncClient", FakeClient)

    visible = "".join(
        [
            chunk
            async for chunk in llm.astream_chat(
                [{"role": "user", "content": "Fasse zusammen"}],
                "test-model",
                "http://llm",
            )
        ]
    )

    assert visible == "\n# Ergebnis"


def test_opencode_session_headers_are_stable_and_isolated(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from uuid import UUID

    monkeypatch.setattr(llm, "get_settings", lambda: SimpleNamespace(data_dir=tmp_path))
    base_url = "https://opencode.ai/inference/go/openai/v1"
    first = llm._auth_headers("test-secret", base_url, session_id="tarscribe-chat-7")
    second = llm._auth_headers("test-secret", base_url, session_id="tarscribe-chat-7")
    other = llm._auth_headers("test-secret", base_url, session_id="tarscribe-chat-8")

    assert first == second
    assert first["Authorization"] == "Bearer test-secret"
    assert first["User-Agent"].startswith("Tarscribe/")
    assert UUID(first["x-opencode-session"])
    assert first["x-opencode-session"] != other["x-opencode-session"]
    assert "test-secret" not in first["x-opencode-session"]
    assert "tarscribe-chat-7" not in first["x-opencode-session"]

    monkeypatch.setattr(
        llm, "get_settings", lambda: SimpleNamespace(data_dir=tmp_path / "other-install")
    )
    other_install = llm._auth_headers("test-secret", base_url, session_id="tarscribe-chat-7")
    assert first["x-opencode-session"] != other_install["x-opencode-session"]
    assert llm._auth_headers("test-secret", "https://api.openai.com/v1") == {
        "Authorization": "Bearer test-secret"
    }
    assert llm._auth_headers(None, "https://opencode.ai.evil.test/zen/go/v1") == {}


@pytest.mark.parametrize(
    ("base_url", "expected_url"),
    [
        (
            "https://opencode.ai/inference/go/openai/v1",
            "https://opencode.ai/inference/go/v1/models",
        ),
        ("https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/models"),
    ],
)
def test_opencode_catalog_uses_models_endpoint_and_chat_models_only(
    monkeypatch, base_url, expected_url
):
    import httpx

    requests = []
    monkeypatch.setattr(llm, "get_llm_config", lambda: {"base_url": base_url})
    monkeypatch.setattr(llm, "get_llm_connections", lambda: [])
    monkeypatch.setattr(llm, "get_llm_api_key", lambda _base: "stored-secret")

    def fake_get(url, **kwargs):
        requests.append((url, kwargs))
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"data": [{"id": model} for model in (
                "glm-5.3-flash", "kimi-k3", "gpt-6-luna", "minimax-m3", "qwen3.8-max"
            )]},
        )

    monkeypatch.setattr(llm.httpx, "get", fake_get)
    assert llm.list_models(base_url) == ["glm-5.3-flash", "kimi-k3"]
    assert requests[0][0] == expected_url
    headers = requests[0][1]["headers"]
    assert headers["Authorization"] == "Bearer stored-secret"
    assert headers["User-Agent"].startswith("Tarscribe/")
    assert headers["x-opencode-session"]


@pytest.mark.asyncio
async def test_opencode_headers_reach_sync_async_stream_and_tool_requests(monkeypatch):
    from contextlib import contextmanager

    import httpx

    requests = []

    def handle(request):
        requests.append(request)
        payload = json.loads(request.content)
        if payload["stream"]:
            body = 'data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, text=body)
        return httpx.Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": "Hallo"},
                         "finish_reason": "stop"}]
        })

    transport = httpx.MockTransport(handle)
    original_async_client = httpx.AsyncClient

    def fake_post(url, **kwargs):
        timeout = kwargs.pop("timeout", 300)
        with httpx.Client(transport=transport, timeout=timeout) as client:
            return client.post(url, **kwargs)

    @contextmanager
    def fake_stream(method, url, **kwargs):
        timeout = kwargs.pop("timeout", None)
        with httpx.Client(transport=transport, timeout=timeout) as client:
            with client.stream(method, url, **kwargs) as response:
                yield response

    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setattr(llm.httpx, "stream", fake_stream)
    monkeypatch.setattr(
        llm.httpx, "AsyncClient",
        lambda **kwargs: original_async_client(transport=transport, **kwargs),
    )
    kwargs = {
        "messages": [{"role": "user", "content": "Hallo"}],
        "model": "glm-5.3-flash",
        "base_url": "https://opencode.ai/inference/go/openai/v1",
        "provider": "opencode-go",
        "api_key": "test-secret",
        "session_id": "tarscribe-chat-42",
    }
    assert "".join(llm.stream_chat(**kwargs)) == "Hallo"
    assert "".join([chunk async for chunk in llm.astream_chat(**kwargs)]) == "Hallo"
    assert llm.chat_complete(**kwargs)["message"]["content"] == "Hallo"
    assert (await llm.achat_complete(**kwargs, tools=[]))["message"]["content"] == "Hallo"
    assert len(requests) == 4
    assert len({request.headers["x-opencode-session"] for request in requests}) == 1
    for request in requests:
        assert str(request.url) == f"{kwargs['base_url']}/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-secret"
        assert request.headers["User-Agent"].startswith("Tarscribe/")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["sync-stream", "async-stream", "sync-complete", "async-complete", "models"]
)
async def test_opencode_errors_expose_safe_provider_detail_across_all_request_paths(
    monkeypatch, mode
):
    from contextlib import contextmanager

    import httpx

    api_key = "sk-opencode-sensitive-test-key"
    detail = (
        "Upstream request failed: This Go model requires Global regions. "
        "Select Global in your workspace's Privacy settings to use it."
    )
    body = json.dumps({"error": {
        "message": f"{detail}\nAuthorization: Bearer {api_key}\x00 " + "x" * 1500,
        "api_key": "a-second-secret-that-must-not-be-displayed",
    }}).encode()
    requests = []
    responses = []

    class ErrorStream(httpx.SyncByteStream, httpx.AsyncByteStream):
        def __iter__(self):
            yield body

        async def __aiter__(self):
            yield body

    def handle(request):
        requests.append(request)
        response = httpx.Response(400, stream=ErrorStream())
        responses.append(response)
        return response

    transport = httpx.MockTransport(handle)
    original_async_client = httpx.AsyncClient

    def fake_request(method, url, **kwargs):
        timeout = kwargs.pop("timeout", 300)
        with httpx.Client(transport=transport, timeout=timeout) as client:
            return client.request(method, url, **kwargs)

    @contextmanager
    def fake_stream(method, url, **kwargs):
        timeout = kwargs.pop("timeout", None)
        with httpx.Client(transport=transport, timeout=timeout) as client:
            with client.stream(method, url, **kwargs) as response:
                assert not response.is_stream_consumed
                yield response

    monkeypatch.setattr(llm.httpx, "post", lambda url, **kwargs: fake_request("POST", url, **kwargs))
    monkeypatch.setattr(llm.httpx, "get", lambda url, **kwargs: fake_request("GET", url, **kwargs))
    monkeypatch.setattr(llm.httpx, "stream", fake_stream)
    monkeypatch.setattr(
        llm.httpx, "AsyncClient",
        lambda **kwargs: original_async_client(transport=transport, **kwargs),
    )
    base_url = "https://opencode.ai/inference/go/openai/v1"
    monkeypatch.setattr(llm, "get_llm_config", lambda: {"base_url": base_url})
    monkeypatch.setattr(llm, "get_llm_connections", lambda: [])
    kwargs = {
        "messages": [{"role": "user", "content": "Hallo"}],
        "model": "deepseek-v4.1-flash",
        "base_url": base_url,
        "provider": "opencode-go",
        "api_key": api_key,
    }
    with pytest.raises(httpx.HTTPStatusError) as raised:
        if mode == "sync-stream":
            list(llm.stream_chat(**kwargs))
        elif mode == "async-stream":
            [chunk async for chunk in llm.astream_chat(**kwargs)]
        elif mode == "sync-complete":
            llm.chat_complete(**kwargs)
        elif mode == "async-complete":
            await llm.achat_complete(**kwargs)
        else:
            llm.list_models(base_url, api_key=api_key)

    error = raised.value
    assert error.request is requests[0]
    assert error.response is responses[0]
    assert error.response.status_code == 400
    assert error.response.is_stream_consumed
    message = str(error)
    assert detail in message
    assert api_key not in message
    assert "a-second-secret-that-must-not-be-displayed" not in message
    assert "[redacted]" in message
    assert "\n" not in message
    assert "\x00" not in message
    assert len(message) <= 1030


def test_other_provider_http_errors_remain_unchanged():
    import httpx

    response = httpx.Response(
        400,
        request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
        json={"error": {"message": "Provider detail should remain private"}},
    )
    with pytest.raises(httpx.HTTPStatusError) as original:
        response.raise_for_status()
    with pytest.raises(httpx.HTTPStatusError) as raised:
        llm._raise_for_status(response, "https://api.openai.com/v1", "openai", None)
    assert str(raised.value) == str(original.value)
    assert raised.value.request is response.request
    assert raised.value.response is response

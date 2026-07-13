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

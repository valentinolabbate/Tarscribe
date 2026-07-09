from __future__ import annotations


def test_duckduckgo_parser_extracts_results():
    from tarscribe_backend.web_search import _DuckDuckGoHTMLParser

    parser = _DuckDuckGoHTMLParser()
    parser.feed(
        """
        <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
        <a class="result__snippet">Kurzer Treffertext.</a>
        """
    )
    parser.close()

    assert parser.results == [
        {
            "title": "Example Docs",
            "url": "https://example.com/docs",
            "snippet": "Kurzer Treffertext.",
        }
    ]


def test_search_web_normalizes_and_fetches(monkeypatch):
    import tarscribe_backend.web_search as web_search

    class Response:
        def __init__(self, data: bytes, content_type: str = "text/html", url: str = "https://example.com"):
            self._data = data
            self.headers = self
            self._content_type = content_type
            self._url = url

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self, *_a):
            return self._data

        def get_content_charset(self):
            return "utf-8"

        def get_content_type(self):
            return self._content_type

        def geturl(self):
            return self._url

    def fake_urlopen(request, timeout):
        url = request.full_url
        return Response(
            b'<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Title</a>'
            b'<a class="result__snippet">Snippet</a>',
            url=url,
        )

    monkeypatch.setattr(web_search.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(web_search, "_assert_public_host", lambda *_a, **_k: None)
    monkeypatch.setattr(web_search, "_fetch_page_text", lambda url: "Page text for context.")

    results = web_search.search_web("query", max_results=1, fetch_pages=1)

    assert len(results) == 1
    assert results[0].title == "Title"
    assert results[0].url == "https://example.com/page"
    assert "Page text" in results[0].text


def _fake_response_factory():
    class Response:
        def __init__(self, data: bytes):
            self._data = data
            self.headers = self

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self, *_a):
            return self._data

        def get_content_charset(self):
            return "utf-8"

    return Response


def test_search_web_retries_post_after_challenge(monkeypatch):
    import tarscribe_backend.web_search as web_search

    Response = _fake_response_factory()
    challenge = b"<html><div class='anomaly-modal'>complete the following challenge</div></html>"
    valid = (
        b'<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Title</a>'
        b'<a class="result__snippet">Snippet</a>'
    )

    calls: list[str] = []

    def fake_urlopen(request, timeout):
        calls.append(request.full_url)
        is_post = request.data is not None
        return Response(challenge if not is_post else valid)

    monkeypatch.setattr(web_search.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(web_search, "_assert_public_host", lambda *_a, **_k: None)
    monkeypatch.setattr(web_search, "_fetch_page_text", lambda url: "")

    results = web_search.search_web("query", max_results=1, fetch_pages=0)

    assert len(results) == 1
    assert results[0].title == "Title"
    assert len(calls) == 2


def test_search_web_raises_when_challenge_persists(monkeypatch):
    import tarscribe_backend.web_search as web_search
    import pytest

    Response = _fake_response_factory()
    challenge = b"<html><div class='anomaly-modal'>complete the following challenge</div></html>"

    def fake_urlopen(request, timeout):
        return Response(challenge)

    monkeypatch.setattr(web_search.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(web_search, "_assert_public_host", lambda *_a, **_k: None)

    with pytest.raises(web_search.WebSearchError):
        web_search.search_web("query", max_results=1, fetch_pages=0)

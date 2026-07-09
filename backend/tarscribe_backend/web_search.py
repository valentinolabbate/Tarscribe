"""DuckDuckGo-backed web search helpers for LLM tools."""

from __future__ import annotations

import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser

from .web_context import WebContextError, _ReadableHTMLParser, _assert_public_host


class WebSearchError(ValueError):
    pass


_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
_REQUEST_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "Accept-Language": "en-US,en;q=0.5",
}
_CHALLENGE_MARKERS = ("anomaly-modal", "complete the following challenge")


@dataclass(frozen=True)
class WebSearchResult:
    title: str
    url: str
    snippet: str
    text: str = ""


class _DuckDuckGoHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._current: dict[str, str] | None = None
        self._capture: str | None = None
        self._depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key: value or "" for key, value in attrs}
        classes = set(attr.get("class", "").split())
        if tag == "a" and "result__a" in classes:
            self._current = {"title": "", "url": _normalize_ddg_url(attr.get("href", "")), "snippet": ""}
            self._capture = "title"
            self._depth = 1
            return
        if self._current is not None and "result__snippet" in classes:
            self._capture = "snippet"
            self._depth = 1
            return
        if self._capture:
            self._depth += 1

    def handle_endtag(self, tag: str) -> None:
        if not self._capture:
            return
        self._depth -= 1
        if self._depth > 0:
            return
        if self._capture == "title" and self._current:
            self.results.append(self._current)
        self._capture = None
        self._depth = 0

    def handle_data(self, data: str) -> None:
        if not self._capture or self._current is None:
            return
        existing = self._current.get(self._capture, "")
        self._current[self._capture] = f"{existing} {data.strip()}".strip()


def search_web(query: str, *, max_results: int = 5, fetch_pages: int = 2) -> list[WebSearchResult]:
    clean_query = query.strip()
    if not clean_query:
        raise WebSearchError("Leere Suchanfrage.")
    max_results = min(8, max(1, max_results))
    fetch_pages = min(max_results, max(0, fetch_pages))

    raw, charset = _fetch_search_html(clean_query)

    parser = _DuckDuckGoHTMLParser()
    parser.feed(raw.decode(charset, errors="replace"))
    parser.close()

    seen: set[str] = set()
    results: list[WebSearchResult] = []
    for raw_result in parser.results:
        target = raw_result.get("url", "").strip()
        title = " ".join(raw_result.get("title", "").split())
        snippet = " ".join(raw_result.get("snippet", "").split())
        if not target or not title or target in seen:
            continue
        if urllib.parse.urlparse(target).scheme not in {"http", "https"}:
            continue
        try:
            _assert_public_host(target)
        except WebContextError:
            continue
        seen.add(target)
        text = ""
        if len(results) < fetch_pages:
            text = _fetch_page_text(target)
        results.append(WebSearchResult(title=title, url=target, snippet=snippet, text=text))
        if len(results) >= max_results:
            break
    return results


def _normalize_ddg_url(value: str) -> str:
    if not value:
        return ""
    absolute = urllib.parse.urljoin("https://duckduckgo.com", value)
    parsed = urllib.parse.urlparse(absolute)
    query = urllib.parse.parse_qs(parsed.query)
    if "uddg" in query and query["uddg"]:
        return query["uddg"][0]
    return absolute


def _is_challenge_page(body: str) -> bool:
    lowered = body.lower()
    return any(marker in lowered for marker in _CHALLENGE_MARKERS)


def _fetch_search_html(query: str) -> tuple[bytes, str]:
    """Fetch the DuckDuckGo HTML results page.

    GET is tried first; if DuckDuckGo answers with an anti-bot challenge page,
    a POST retry is attempted. A persistent challenge raises a clear error so
    the caller surfaces a meaningful message instead of silently returning
    zero results.
    """
    encoded = urllib.parse.urlencode({"q": query})
    attempts: tuple[tuple[str, bytes | None], ...] = (
        (f"https://html.duckduckgo.com/html/?{encoded}", None),
        ("https://html.duckduckgo.com/html/", encoded.encode()),
    )
    last_error: str | None = None
    for url, body in attempts:
        request = urllib.request.Request(url, data=body, headers=_REQUEST_HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                raw = response.read(1_500_000)
                charset = response.headers.get_content_charset() or "utf-8"
        except OSError as exc:
            last_error = f"DuckDuckGo-Suche fehlgeschlagen: {exc}"
            continue
        decoded = raw.decode(charset, errors="replace")
        if not _is_challenge_page(decoded):
            return raw, charset
        last_error = "DuckDuckGo anti-bot challenge ausgelöst (keine Ergebnisse)."
    raise WebSearchError(last_error or "DuckDuckGo-Suche fehlgeschlagen.")


def _fetch_page_text(url: str) -> str:
    try:
        _assert_public_host(url)
        request = urllib.request.Request(url, headers=_REQUEST_HEADERS)
        opener = urllib.request.build_opener(_PublicRedirectHandler)
        with opener.open(request, timeout=8) as response:
            final_url = response.geturl()
            _assert_public_host(final_url)
            content_type = response.headers.get_content_type()
            if content_type not in {"text/html", "application/xhtml+xml", "text/plain"}:
                return ""
            charset = response.headers.get_content_charset() or "utf-8"
            raw = response.read(800_000)
        if content_type == "text/plain":
            text = raw.decode(charset, errors="replace")
        else:
            parser = _ReadableHTMLParser()
            parser.feed(raw.decode(charset, errors="replace"))
            parser.close()
            text = parser.text
    except Exception:
        return ""
    compact = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return compact[:4000]


class _PublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        target = urllib.parse.urljoin(req.full_url, newurl)
        _assert_public_host(target)
        return super().redirect_request(req, fp, code, msg, headers, target)

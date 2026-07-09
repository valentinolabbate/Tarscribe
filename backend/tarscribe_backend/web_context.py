"""Small same-origin HTML crawler for topic web context."""

from __future__ import annotations

import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html import escape
from html.parser import HTMLParser


class WebContextError(ValueError):
    """Raised when a URL cannot be crawled into usable context."""


@dataclass(frozen=True)
class WebPage:
    url: str
    title: str
    text: str
    html: str


@dataclass(frozen=True)
class CrawlResult:
    root_url: str
    title: str
    pages: list[WebPage]
    content_markdown: str
    snapshot_html: str


_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "canvas"}
_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
}
_BLOCKED_HOSTS = {"localhost", "localhost.localdomain"}


class _ReadableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self._parts: list[str] = []
        self._title_parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)
        if tag == "title":
            self._in_title = True
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag in _SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        text = _squash_inline_space(data)
        if not text:
            return
        if self._in_title:
            self._title_parts.append(text)
        if self._skip_depth:
            return
        self._parts.append(text)

    @property
    def title(self) -> str:
        return _squash_inline_space(" ".join(self._title_parts))

    @property
    def text(self) -> str:
        lines = [_squash_inline_space(line) for line in "".join(self._parts).splitlines()]
        compact = [line for line in lines if line]
        return "\n".join(compact)


def crawl_site(
    url: str,
    *,
    max_pages: int = 8,
    max_depth: int = 1,
    timeout_sec: float = 8.0,
    max_bytes_per_page: int = 1_000_000,
) -> CrawlResult:
    """Fetch a same-origin slice of a website and return indexable markdown."""
    if max_pages < 1 or max_pages > 25:
        raise WebContextError("Seitenlimit muss zwischen 1 und 25 liegen.")
    if max_depth < 0 or max_depth > 3:
        raise WebContextError("Tiefe muss zwischen 0 und 3 liegen.")

    root_url = _normalize_url(url)
    _assert_public_host(root_url)
    root_origin = _origin_key(root_url)

    queue: list[tuple[str, int]] = [(root_url, 0)]
    queued = {root_url}
    seen: set[str] = set()
    pages: list[WebPage] = []
    errors: list[str] = []

    while queue and len(pages) < max_pages:
        current_url, depth = queue.pop(0)
        if current_url in seen:
            continue
        seen.add(current_url)
        try:
            final_url, html = _fetch_html(
                current_url,
                root_origin=root_origin,
                timeout_sec=timeout_sec,
                max_bytes=max_bytes_per_page,
            )
        except WebContextError as exc:
            errors.append(str(exc))
            continue

        parser = _ReadableHTMLParser()
        parser.feed(html)
        parser.close()
        text = parser.text.strip()
        if text:
            pages.append(
                WebPage(
                    url=final_url,
                    title=parser.title or _fallback_title(final_url),
                    text=text,
                    html=html,
                )
            )

        if depth >= max_depth:
            continue
        for href in parser.links:
            next_url = _normalize_link(href, final_url)
            if not next_url or _origin_key(next_url) != root_origin:
                continue
            if next_url in seen or next_url in queued:
                continue
            queue.append((next_url, depth + 1))
            queued.add(next_url)

    if not pages:
        detail = errors[0] if errors else "Keine lesbaren HTML-Inhalte gefunden."
        raise WebContextError(detail)

    title = pages[0].title or _fallback_title(root_url)
    content_markdown = _format_markdown(root_url, title, pages)
    snapshot_html = _format_snapshot(root_url, title, pages)
    return CrawlResult(
        root_url=root_url,
        title=title,
        pages=pages,
        content_markdown=content_markdown,
        snapshot_html=snapshot_html,
    )


def _fetch_html(
    url: str,
    *,
    root_origin: tuple[str, str, int],
    timeout_sec: float,
    max_bytes: int,
) -> tuple[str, str]:
    _assert_public_host(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Tarscribe-WebContext/1.0",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
    )
    opener = urllib.request.build_opener(_same_origin_redirect_handler(root_origin))
    try:
        with opener.open(request, timeout=timeout_sec) as response:
            final_url = _normalize_url(response.geturl())
            _assert_public_host(final_url)
            if _origin_key(final_url) != root_origin:
                raise WebContextError("Weiterleitung auf eine andere Website wurde blockiert.")
            content_type = response.headers.get_content_type()
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise WebContextError(f"Kein HTML-Inhalt: {content_type}")
            charset = response.headers.get_content_charset() or "utf-8"
            raw = response.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        raise WebContextError(f"HTTP {exc.code} beim Laden der Seite.") from exc
    except urllib.error.URLError as exc:
        raise WebContextError(f"Seite konnte nicht geladen werden: {exc.reason}") from exc
    except OSError as exc:
        raise WebContextError(f"Seite konnte nicht geladen werden: {exc}") from exc

    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
    return final_url, raw.decode(charset, errors="replace")


def _normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse((url or "").strip())
    if not parsed.scheme:
        parsed = urllib.parse.urlparse(f"https://{url.strip()}")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WebContextError("Bitte eine gültige http- oder https-URL eingeben.")
    if parsed.username or parsed.password:
        raise WebContextError("URLs mit Zugangsdaten werden nicht akzeptiert.")
    try:
        parsed.port
    except ValueError as exc:
        raise WebContextError("Bitte eine gültige http- oder https-URL eingeben.") from exc
    path = parsed.path or "/"
    return urllib.parse.urlunparse(
        parsed._replace(path=path, params="", fragment="")
    )


def _normalize_link(href: str, base_url: str) -> str | None:
    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
        return None
    try:
        return _normalize_url(urllib.parse.urljoin(base_url, href))
    except WebContextError:
        return None


def _origin_key(url: str) -> tuple[str, str, int]:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, host, port


def _assert_public_host(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").strip().lower()
    if not host or host in _BLOCKED_HOSTS or host.endswith(".localhost"):
        raise WebContextError("Lokale oder private Hosts werden aus Sicherheitsgründen blockiert.")
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise WebContextError(f"Host konnte nicht aufgelöst werden: {host}") from exc
        addresses = []
        for info in infos:
            try:
                addresses.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
    if not addresses:
        raise WebContextError(f"Host konnte nicht aufgelöst werden: {host}")
    for address in addresses:
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise WebContextError(
                "Lokale oder private Hosts werden aus Sicherheitsgründen blockiert."
            )


def _same_origin_redirect_handler(
    root_origin: tuple[str, str, int],
) -> type[urllib.request.HTTPRedirectHandler]:
    class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
            target = _normalize_url(urllib.parse.urljoin(req.full_url, newurl))
            _assert_public_host(target)
            if _origin_key(target) != root_origin:
                raise WebContextError("Weiterleitung auf eine andere Website wurde blockiert.")
            return super().redirect_request(req, fp, code, msg, headers, target)

    return SameOriginRedirectHandler


def _fallback_title(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or "Website"
    path = parsed.path.strip("/")
    return path.rsplit("/", 1)[-1] or host


def _squash_inline_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _format_markdown(root_url: str, title: str, pages: list[WebPage]) -> str:
    parts = [
        f"# {title}",
        "",
        f"Quelle: {root_url}",
        f"Gecrawlte Seiten: {len(pages)}",
    ]
    for index, page in enumerate(pages, start=1):
        parts.extend(
            [
                "",
                f"## {index}. {page.title}",
                f"URL: {page.url}",
                "",
                page.text,
            ]
        )
    return "\n".join(parts).strip()


def _format_snapshot(root_url: str, title: str, pages: list[WebPage]) -> str:
    page_sections = []
    for index, page in enumerate(pages, start=1):
        page_sections.append(
            "\n".join(
                [
                    "<section>",
                    f"<h2>{index}. {escape(page.title)}</h2>",
                    f'<p><a href="{escape(page.url, quote=True)}">{escape(page.url)}</a></p>',
                    "<h3>Extrahierter Text</h3>",
                    f"<pre>{escape(page.text)}</pre>",
                    "<details>",
                    "<summary>Original-HTML</summary>",
                    f"<pre>{escape(page.html)}</pre>",
                    "</details>",
                    "</section>",
                ]
            )
        )
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="de">',
            "<head>",
            '<meta charset="utf-8">',
            f"<title>{escape(title)}</title>",
            "<style>",
            "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;max-width:980px;margin:40px auto;padding:0 24px;color:#172033}",
            "section{border-top:1px solid #d8dee8;margin-top:28px;padding-top:20px}",
            "pre{white-space:pre-wrap;background:#f6f8fb;border:1px solid #d8dee8;border-radius:8px;padding:14px;overflow:auto}",
            "a{color:#2457d6}",
            "</style>",
            "</head>",
            "<body>",
            f"<h1>{escape(title)}</h1>",
            f'<p>Quelle: <a href="{escape(root_url, quote=True)}">{escape(root_url)}</a></p>',
            f"<p>Gecrawlte Seiten: {len(pages)}</p>",
            *page_sections,
            "</body>",
            "</html>",
        ]
    )

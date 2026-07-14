"""LLM-based transcript analysis: action-item extraction and chapter detection.

Both functions take a ``chat`` callable (messages -> full response text) so the
LLM transport stays in jobs.py and the parsing logic here is unit-testable.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from datetime import date, datetime

Chat = Callable[[list[dict]], str]
AsyncChat = Callable[[list[dict]], Awaitable[str]]

# Keep prompts well under the configured chunk budget so the instructions fit.
ACTION_ITEM_KINDS = ("task", "decision")
MAX_CHAPTERS = 12
MIN_CHAPTER_GAP_SEC = 15.0
MAX_DICTATION_TITLE_LEN = 80


def _extract_json_array(raw: str) -> list:
    """Pull the first JSON array out of an LLM response (tolerates code fences)."""
    text = raw.strip()
    # Strip ```json ... ``` fences if present.
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _extract_json_object(raw: str) -> dict:
    """Pull the first JSON object out of an LLM response (tolerates code fences)."""
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


# ── Action items ─────────────────────────────────────────────────────────────

_ITEMS_SYSTEM = (
    "Du extrahierst Aufgaben (Action-Items) und getroffene Entscheidungen aus "
    "Gesprächs-Transkripten. Antworte ausschließlich mit einem JSON-Array, ohne "
    "weiteren Text. Keine Erfindungen — nur was im Transkript steht."
)

_ITEMS_USER = """Extrahiere alle konkreten Aufgaben und getroffenen Entscheidungen.

Referenzdatum für relative Fristen: {reference_date}
{clarification_block}

Format: JSON-Array von Objekten mit genau diesen Feldern:
- "kind": "task" für eine Aufgabe, "decision" für eine Entscheidung
- "text": die Aufgabe bzw. Entscheidung, knapp in einem Satz
- "assignee": verantwortliche Person oder null
- "recipient": Empfänger einer ausdrücklichen Zusage oder null
- "due": Frist wie im Gespräch genannt oder null
- "due_date": Frist als ISO-Datum YYYY-MM-DD oder null
- "source_quote": kurze, wörtliche Belegstelle aus dem Transkript oder null
- "source_start_sec": Sekundenwert der Zeitmarke direkt vor der Belegstelle oder null
- "confidence": Zahl zwischen 0 und 1 für die Sicherheit der Erkennung

Regeln:
- Setze "due_date" nur, wenn aus dem Transkript eindeutig ein Datum ableitbar ist.
- Nutze das Referenzdatum für relative Fristen wie "morgen", "Freitag" oder "nächste Woche".
- Erfinde keine Fristen. Ohne eindeutiges Datum: "due_date": null.
- Für Entscheidungen sind "due" und "due_date" normalerweise null.
- Eine Aufgabe ist nur dann eine Zusage, wenn eine Person konkrete Verantwortung übernimmt.
- Übernimm source_quote exakt aus dem Transkript und nutze die unmittelbar davor stehende
  Zeitmarke für source_start_sec. Erfinde weder Zitate noch Zeitmarken.
{speakers_hint}
Gib [] zurück, wenn nichts gefunden wird.

Transkript:
{chunk}"""


def _clarification_block(clarification: str | None) -> str:
    text = (clarification or "").strip()
    if not text:
        return ""
    return (
        "\nZusätzliche Klarstellung des Nutzers:\n"
        f"{text}\n"
        "Nutze diese Klarstellung nur, um Namen, Begriffe und missverständliche Stellen korrekt "
        "zu verstehen. Leite daraus keine zusätzlichen Aufgaben oder Entscheidungen ab."
    )


def _norm_text(s: str) -> str:
    return re.sub(r"\W+", " ", s.lower()).strip()


def _reference_date_iso(reference_date: date | datetime | str | None) -> str:
    if isinstance(reference_date, datetime):
        return reference_date.date().isoformat()
    if isinstance(reference_date, date):
        return reference_date.isoformat()
    cleaned = _clean_due_date(reference_date)
    return cleaned or date.today().isoformat()


def _clean_due_date(raw: object) -> str | None:
    value = str(raw or "").strip()
    if not value or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def extract_action_items(
    chat: Chat,
    text: str,
    speakers: list[str],
    chunk_size: int = 48000,
    progress=None,
    reference_date: date | datetime | str | None = None,
    clarification: str | None = None,
) -> list[dict]:
    """Run extraction over the (possibly chunked) transcript; dedupe by text."""
    from .llm import chunk_text

    speakers_hint = (
        f"Bekannte Personen: {', '.join(speakers)}\n" if speakers else ""
    )
    reference_date_text = _reference_date_iso(reference_date)
    items: list[dict] = []
    seen: set[str] = set()
    chunks = chunk_text(text, size=chunk_size)
    for i, chunk in enumerate(chunks):
        if progress:
            progress(0.05 + 0.9 * (i / len(chunks)))
        raw = chat([
            {"role": "system", "content": _ITEMS_SYSTEM},
            {
                "role": "user",
                "content": _ITEMS_USER.format(
                    reference_date=reference_date_text,
                    clarification_block=_clarification_block(clarification),
                    speakers_hint=speakers_hint,
                    chunk=chunk,
                ),
            },
        ])
        for entry in _extract_json_array(raw):
            item = _coerce_action_item(entry)
            if not item:
                continue
            key = _norm_text(item["text"])
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    return items


async def extract_action_items_async(
    chat: AsyncChat,
    text: str,
    speakers: list[str],
    chunk_size: int = 48000,
    progress=None,
    reference_date: date | datetime | str | None = None,
    clarification: str | None = None,
) -> list[dict]:
    from .llm import chunk_text

    speakers_hint = f"Bekannte Personen: {', '.join(speakers)}\n" if speakers else ""
    reference_date_text = _reference_date_iso(reference_date)
    items: list[dict] = []
    seen: set[str] = set()
    chunks = chunk_text(text, size=chunk_size)
    for i, chunk in enumerate(chunks):
        if progress:
            progress(0.05 + 0.9 * (i / len(chunks)))
        raw = await chat(
            [
                {"role": "system", "content": _ITEMS_SYSTEM},
                {
                    "role": "user",
                    "content": _ITEMS_USER.format(
                        reference_date=reference_date_text,
                        clarification_block=_clarification_block(clarification),
                        speakers_hint=speakers_hint,
                        chunk=chunk,
                    ),
                },
            ]
        )
        for entry in _extract_json_array(raw):
            item = _coerce_action_item(entry)
            if not item:
                continue
            key = _norm_text(item["text"])
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    return items


_ENRICH_ITEMS_SYSTEM = (
    "Du suchst ausschließlich Belegstellen für bereits vorhandene Aufgaben und Entscheidungen. "
    "Du erzeugst keine neuen Einträge und änderst keine bestehenden Inhalte. Antworte nur mit "
    "einem JSON-Array ohne Markdown."
)

_ENRICH_ITEMS_USER = """Ordne den vorhandenen Einträgen ihre Belegstellen im Transkript zu.

Vorhandene Einträge:
{items_json}

Format: JSON-Array mit Objekten aus genau diesen Feldern:
- "item_id": ID des vorhandenen Eintrags
- "source_quote": kurze, wörtliche Passage aus dem Transkript oder null
- "recipient": Empfänger einer ausdrücklichen Zusage oder null
- "confidence": Zahl zwischen 0 und 1

Regeln:
- Gib nur IDs aus der Liste zurück.
- source_quote muss wortgetreu im Transkript vorkommen.
- Ergänze keine Aufgabe, Entscheidung, Frist oder verantwortliche Person.
- Wenn kein eindeutiger Beleg existiert, setze source_quote auf null und confidence auf 0.
- recipient ist nur bei einer ausdrücklich an jemanden gerichteten Zusage zu setzen.

Transkript mit Zeitmarken:
{chunk}"""


async def enrich_existing_action_items_async(
    chat: AsyncChat,
    text: str,
    items: list[dict],
    chunk_size: int = 48000,
    progress=None,
) -> list[dict]:
    from .llm import chunk_text

    allowed_ids = {int(item["id"]) for item in items}
    items_json = json.dumps(items, ensure_ascii=False)
    best: dict[int, dict] = {}
    chunks = chunk_text(text, size=chunk_size)
    for index, chunk in enumerate(chunks):
        if progress:
            progress((index + 1) / len(chunks))
        raw = await chat(
            [
                {"role": "system", "content": _ENRICH_ITEMS_SYSTEM},
                {
                    "role": "user",
                    "content": _ENRICH_ITEMS_USER.format(items_json=items_json, chunk=chunk),
                },
            ]
        )
        for entry in _extract_json_array(raw):
            if not isinstance(entry, dict):
                continue
            try:
                item_id = int(entry.get("item_id"))
            except (TypeError, ValueError):
                continue
            if item_id not in allowed_ids:
                continue
            quote = re.sub(r"\s+", " ", str(entry.get("source_quote") or "")).strip()
            recipient = re.sub(r"\s+", " ", str(entry.get("recipient") or "")).strip()
            try:
                confidence = max(0.0, min(1.0, float(entry.get("confidence") or 0)))
            except (TypeError, ValueError):
                confidence = 0.0
            candidate = {
                "item_id": item_id,
                "source_quote": quote[:1000] or None,
                "recipient": recipient[:200] or None,
                "confidence": confidence,
            }
            previous = best.get(item_id)
            if previous is None or candidate["confidence"] > previous["confidence"]:
                best[item_id] = candidate
    return list(best.values())


# ── Dictation inbox ──────────────────────────────────────────────────────────

_DICTATION_SYSTEM = (
    "Du verarbeitest kurze Diktat-Notizen. Antworte ausschließlich mit einem JSON-Objekt, "
    "ohne Markdown und ohne zusätzlichen Text. Keine Erfindungen."
)

_DICTATION_USER = """Analysiere dieses Diktat.

Verfügbare Themenbereiche: {topics}
Referenzdatum für relative Fristen: {reference_date}

Format: JSON-Objekt mit genau diesen Feldern:
- "title": kurzer deutscher Titel, höchstens 8 Wörter
- "topic_name": passender Themenbereich aus der Liste oder null
- "topic_confidence": Zahl zwischen 0 und 1
- "action_items": Array von Objekten wie {{"kind":"task","text":"...","assignee":null,"due":"morgen","due_date":"2026-06-19"}}

Regeln:
- Wähle nur einen vorhandenen Themenbereich aus der Liste.
- Wenn du unsicher bist, setze topic_name auf null und topic_confidence auf 0.
- action_items nur für konkrete Aufgaben oder Entscheidungen, sonst [].
- Setze due_date als YYYY-MM-DD nur bei eindeutig ableitbarer Frist; nutze das Referenzdatum
  für relative Fristen. Ohne eindeutiges Datum: null.

Diktat:
{text}"""


def _clean_title(raw: object) -> str | None:
    title = re.sub(r"\s+", " ", str(raw or "")).strip(" \t\n\r\"'`")
    if not title:
        return None
    if len(title) > MAX_DICTATION_TITLE_LEN:
        title = title[:MAX_DICTATION_TITLE_LEN].rsplit(" ", 1)[0].rstrip()
    return title or None


def _coerce_action_item(entry: object) -> dict | None:
    if not isinstance(entry, dict):
        return None
    item_text = str(entry.get("text") or "").strip()
    if not item_text:
        return None
    kind = str(entry.get("kind") or "task").strip().lower()
    assignee = entry.get("assignee")
    recipient = entry.get("recipient")
    due = entry.get("due")
    quote = re.sub(r"\s+", " ", str(entry.get("source_quote") or "")).strip()
    try:
        source_start_sec = max(0.0, float(entry.get("source_start_sec")))
    except (TypeError, ValueError):
        source_start_sec = None
    try:
        confidence = max(0.0, min(1.0, float(entry.get("confidence"))))
    except (TypeError, ValueError):
        confidence = 0.5
    return {
        "kind": kind if kind in ACTION_ITEM_KINDS else "task",
        "text": item_text,
        "assignee": str(assignee).strip() if assignee else None,
        "recipient": str(recipient).strip() if recipient else None,
        "due": str(due).strip() if due else None,
        "due_date": _clean_due_date(entry.get("due_date")),
        "source_quote": quote[:1000] or None,
        "source_start_sec": source_start_sec,
        "confidence": confidence,
    }


def analyze_dictation(
    chat: Chat,
    text: str,
    topic_names: list[str],
    chunk_size: int = 48000,
    reference_date: date | datetime | str | None = None,
) -> dict:
    """Return title/topic suggestion/action items for a short dictation."""
    from .llm import chunk_text

    source = chunk_text(text, size=chunk_size)[0]
    reference_date_text = _reference_date_iso(reference_date)
    raw = chat(
        [
            {"role": "system", "content": _DICTATION_SYSTEM},
            {
                "role": "user",
                "content": _DICTATION_USER.format(
                    topics=", ".join(topic_names) if topic_names else "keine",
                    reference_date=reference_date_text,
                    text=source,
                ),
            },
        ]
    )
    data = _extract_json_object(raw)
    title = _clean_title(data.get("title"))
    topic_name = str(data.get("topic_name") or "").strip() or None
    try:
        confidence = float(data.get("topic_confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(confidence, 1.0))

    items: list[dict] = []
    seen: set[str] = set()
    for entry in data.get("action_items") or []:
        item = _coerce_action_item(entry)
        if not item:
            continue
        key = _norm_text(item["text"])
        if key in seen:
            continue
        seen.add(key)
        items.append(item)

    return {
        "title": title,
        "topic_name": topic_name,
        "topic_confidence": confidence,
        "action_items": items,
    }


async def analyze_dictation_async(
    chat: AsyncChat,
    text: str,
    topic_names: list[str],
    chunk_size: int = 48000,
    reference_date: date | datetime | str | None = None,
) -> dict:
    from .llm import chunk_text

    source = chunk_text(text, size=chunk_size)[0]
    reference_date_text = _reference_date_iso(reference_date)
    raw = await chat(
        [
            {"role": "system", "content": _DICTATION_SYSTEM},
            {
                "role": "user",
                "content": _DICTATION_USER.format(
                    topics=", ".join(topic_names) if topic_names else "keine",
                    reference_date=reference_date_text,
                    text=source,
                ),
            },
        ]
    )
    data = _extract_json_object(raw)
    title = _clean_title(data.get("title"))
    topic_name = str(data.get("topic_name") or "").strip() or None
    try:
        confidence = float(data.get("topic_confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(confidence, 1.0))

    items: list[dict] = []
    seen: set[str] = set()
    for entry in data.get("action_items") or []:
        item = _coerce_action_item(entry)
        if not item:
            continue
        key = _norm_text(item["text"])
        if key in seen:
            continue
        seen.add(key)
        items.append(item)

    return {
        "title": title,
        "topic_name": topic_name,
        "topic_confidence": confidence,
        "action_items": items,
    }


# ── Chapters ─────────────────────────────────────────────────────────────────

_CHAPTERS_SYSTEM = (
    "Du gliederst Transkripte anhand von Themenwechseln in Kapitel. Antworte "
    "ausschließlich mit einem JSON-Array, ohne weiteren Text."
)

_CHAPTERS_USER = """Teile die Aufnahme in sinnvolle Kapitel nach Themenwechseln.

Regeln:
- 3 bis {max_chapters} Kapitel, das erste beginnt bei Sekunde 0
- "start_sec" muss eine der Zeitmarken aus dem Transkript sein
- "title": prägnanter deutscher Titel, höchstens 6 Wörter

Format: JSON-Array von {{"start_sec": Zahl, "title": "..."}}.

Transkript (Zeitmarken in Sekunden):
{lines}"""


def _condense_lines(lines: list[str], budget: int) -> str:
    """Fit timestamped lines into the character budget by truncating, then sampling."""
    short = [line[:150] for line in lines]
    text = "\n".join(short)
    step = 1
    while len(text) > budget and step < 64:
        step *= 2
        # Always keep the first and last line so the LLM sees the full range.
        sampled = short[::step]
        if short and sampled[-1] != short[-1]:
            sampled.append(short[-1])
        text = "\n".join(sampled)
    return text


def generate_chapters(chat: Chat, utterances, duration_sec: float, chunk_size: int = 48000) -> list[dict]:
    """Chapter list [{start, end, title}] from timestamped utterances."""
    lines = [
        f"[{int(u.start)}] {u.speaker + ': ' if u.speaker else ''}{u.text}"
        for u in utterances
    ]
    if not lines:
        return []
    raw = chat([
        {"role": "system", "content": _CHAPTERS_SYSTEM},
        {
            "role": "user",
            "content": _CHAPTERS_USER.format(
                max_chapters=MAX_CHAPTERS, lines=_condense_lines(lines, chunk_size)
            ),
        },
    ])

    parsed: list[tuple[float, str]] = []
    for entry in _extract_json_array(raw):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        try:
            start = float(entry.get("start_sec"))
        except (TypeError, ValueError):
            continue
        if not title:
            continue
        parsed.append((max(0.0, min(start, duration_sec)), title))

    parsed.sort(key=lambda c: c[0])
    chapters: list[dict] = []
    for start, title in parsed[:MAX_CHAPTERS]:
        if chapters and start - chapters[-1]["start"] < MIN_CHAPTER_GAP_SEC:
            continue
        chapters.append({"start": start, "title": title})
    if not chapters:
        return []
    chapters[0]["start"] = 0.0  # YouTube chapter convention: list starts at 0:00
    for i, ch in enumerate(chapters):
        ch["end"] = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration_sec
    return chapters


async def generate_chapters_async(
    chat: AsyncChat, utterances, duration_sec: float, chunk_size: int = 48000
) -> list[dict]:
    lines = [
        f"[{int(u.start)}] {u.speaker + ': ' if u.speaker else ''}{u.text}"
        for u in utterances
    ]
    if not lines:
        return []
    raw = await chat(
        [
            {"role": "system", "content": _CHAPTERS_SYSTEM},
            {
                "role": "user",
                "content": _CHAPTERS_USER.format(
                    max_chapters=MAX_CHAPTERS, lines=_condense_lines(lines, chunk_size)
                ),
            },
        ]
    )

    parsed: list[tuple[float, str]] = []
    for entry in _extract_json_array(raw):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        try:
            start = float(entry.get("start_sec"))
        except (TypeError, ValueError):
            continue
        if not title:
            continue
        parsed.append((max(0.0, min(start, duration_sec)), title))

    parsed.sort(key=lambda c: c[0])
    chapters: list[dict] = []
    for start, title in parsed[:MAX_CHAPTERS]:
        if chapters and start - chapters[-1]["start"] < MIN_CHAPTER_GAP_SEC:
            continue
        chapters.append({"start": start, "title": title})
    if not chapters:
        return []
    chapters[0]["start"] = 0.0
    for i, ch in enumerate(chapters):
        ch["end"] = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration_sec
    return chapters

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence
import math
import re
from datetime import datetime, timezone

from sqlmodel import Session, select

from .models import ActionItem, Transcript, Word


_ELLIPSIS_PATTERN = re.compile(r"(?:\[?\.\.\.\]?|…+)")


def _match_candidates(
    quote_tokens: list[str],
    transcript_tokens: list[re.Match[str]],
    word_ends: list[int],
    word_parts: Sequence[tuple[float, str]],
) -> list[float]:
    candidates: list[float] = []
    for index in range(len(transcript_tokens) - len(quote_tokens) + 1):
        window = transcript_tokens[index : index + len(quote_tokens)]
        if [match.group() for match in window] != quote_tokens:
            continue
        word_index = min(bisect_right(word_ends, window[0].start()), len(word_parts) - 1)
        candidates.append(word_parts[word_index][0])
    return candidates


def source_quote_position_from_word_parts(
    word_parts: Sequence[tuple[float, str]],
    quote: str,
    hint: float | None = None,
) -> float | None:
    quote_tokens = re.findall(r"\w+", quote.casefold())
    if len(" ".join(quote_tokens)) < 8 or not word_parts:
        return None

    normalized_parts = [text.casefold() for _start, text in word_parts]
    transcript_text = "".join(normalized_parts)
    transcript_tokens = list(re.finditer(r"\w+", transcript_text))

    word_ends: list[int] = []
    length = 0
    for text in normalized_parts:
        length += len(text)
        word_ends.append(length)

    candidates = _match_candidates(quote_tokens, transcript_tokens, word_ends, word_parts)
    if not candidates:
        for segment in _ELLIPSIS_PATTERN.split(quote.casefold()):
            segment_tokens = re.findall(r"\w+", segment)
            if len(segment_tokens) < 3 or len(" ".join(segment_tokens)) < 8:
                continue
            candidates = _match_candidates(
                segment_tokens, transcript_tokens, word_ends, word_parts
            )
            if candidates:
                break

    if not candidates:
        return None
    try:
        parsed_hint = float(hint) if hint is not None else None
    except (TypeError, ValueError):
        parsed_hint = None
    if parsed_hint is not None and math.isfinite(parsed_hint):
        return min(candidates, key=lambda start: abs(start - parsed_hint))
    return candidates[0]


def repair_missing_action_item_source_positions(session: Session) -> int:
    items = session.exec(
        select(ActionItem).where(
            ActionItem.source_quote != None,  # noqa: E711
            ActionItem.source_start_sec == None,  # noqa: E711
        )
    ).all()
    by_recording: dict[int, list[ActionItem]] = {}
    for item in items:
        by_recording.setdefault(item.recording_id, []).append(item)

    repaired = 0
    repaired_at = datetime.now(timezone.utc)
    for recording_id, recording_items in by_recording.items():
        transcript = session.exec(
            select(Transcript)
            .where(Transcript.recording_id == recording_id)
            .order_by(Transcript.created_at.desc(), Transcript.id.desc())
        ).first()
        if not transcript:
            continue
        words = session.exec(
            select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
        ).all()
        word_parts = [(word.start, word.text) for word in words]
        for item in recording_items:
            position = source_quote_position_from_word_parts(
                word_parts,
                item.source_quote or "",
            )
            if position is None:
                continue
            item.source_start_sec = position
            if item.enrichment_state in {"pending", "no_match"}:
                item.enrichment_state = "enriched"
                item.enriched_at = repaired_at
            item.updated_at = repaired_at
            session.add(item)
            repaired += 1
    return repaired

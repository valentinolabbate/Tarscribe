"""Stage C: combine ASR words with diarization segments into a speaker transcript.

Cheap and deterministic, so it can be recomputed instantly whenever the active
diarization run or manual speaker labels change.
"""

from __future__ import annotations

import re as regex
from bisect import bisect_right
from dataclasses import dataclass


_TERMINAL_PUNCTUATION = regex.compile(r"[.!?…]+(?:[\"')\]}»”’]+)?$")
_BOUNDARY_MAX_WORDS = 3
_BOUNDARY_MAX_SECONDS = 1.2
_PAUSE_BOUNDARY_SECONDS = 0.6
_BACKCHANNELS = {
    "ach so",
    "alles klar",
    "genau",
    "hm",
    "ja",
    "ja ich weiß",
    "klar",
    "mhm",
    "nein",
    "okay",
    "okay ja",
    "richtig",
    "stimmt",
    "verstehe",
    "yeah",
    "yes",
}


@dataclass
class _Word:
    start: float
    end: float
    text: str


@dataclass
class Utterance:
    speaker: str
    start: float
    end: float
    text: str


def assign_speaker(word_start: float, word_end: float, seg_starts: list[float], segments) -> str:
    """Return the speaker label whose segment overlaps the word the most."""
    if not segments:
        return "SPEAKER_00"
    # Candidate window around the word using sorted segment starts.
    idx = bisect_right(seg_starts, word_end)
    best_label = None
    best_overlap = 0.0
    nearest_label = segments[min(idx, len(segments) - 1)].speaker
    nearest_dist = float("inf")
    lo = max(0, idx - 6)
    hi = min(len(segments), idx + 2)
    for seg in segments[lo:hi]:
        overlap = min(word_end, seg.end) - max(word_start, seg.start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = seg.speaker
        # Track nearest segment as a fallback for words in silence gaps.
        mid_w = (word_start + word_end) / 2
        dist = 0.0 if seg.start <= mid_w <= seg.end else min(
            abs(mid_w - seg.start), abs(mid_w - seg.end)
        )
        if dist < nearest_dist:
            nearest_dist = dist
            nearest_label = seg.speaker
    return best_label or nearest_label


def _value(word, key: str):
    if isinstance(word, dict):
        return word.get(key)
    return getattr(word, key)


def _is_phrase_boundary(words, index: int) -> bool:
    previous = words[index - 1]
    current = words[index]
    text = str(_value(previous, "text") or "").strip()
    gap = float(_value(current, "start") or 0.0) - float(_value(previous, "end") or 0.0)
    return bool(_TERMINAL_PUNCTUATION.search(text)) or gap >= _PAUSE_BOUNDARY_SECONDS


def _is_backchannel(words) -> bool:
    text = "".join(str(_value(word, "text") or "") for word in words).casefold()
    normalized = " ".join(regex.findall(r"[a-zäöüß]+", text))
    return normalized in _BACKCHANNELS


def stabilize_speaker_boundaries(words, speakers: list[str]) -> list[str]:
    if len(words) != len(speakers) or len(words) < 2:
        return list(speakers)

    ranges: list[tuple[int, int]] = []
    start = 0
    for index in range(1, len(words)):
        if _is_phrase_boundary(words, index):
            ranges.append((start, index))
            start = index
    ranges.append((start, len(words)))

    result = list(speakers)
    for start, end in ranges:
        changes = [index for index in range(start + 1, end) if speakers[index] != speakers[index - 1]]
        if len(changes) != 1:
            continue
        cut = changes[0]
        prefix_words = words[start:cut]
        suffix_words = words[cut:end]
        prefix_duration = float(_value(prefix_words[-1], "end") or 0.0) - float(
            _value(prefix_words[0], "start") or 0.0
        )
        suffix_duration = float(_value(suffix_words[-1], "end") or 0.0) - float(
            _value(suffix_words[0], "start") or 0.0
        )
        prefix_backchannel = _is_backchannel(prefix_words)
        suffix_backchannel = _is_backchannel(suffix_words)
        if prefix_backchannel or suffix_backchannel:
            continue
        prefix_is_edge = (
            len(prefix_words) <= _BOUNDARY_MAX_WORDS
            and prefix_duration <= _BOUNDARY_MAX_SECONDS
        )
        suffix_is_edge = (
            len(suffix_words) <= _BOUNDARY_MAX_WORDS
            and suffix_duration <= _BOUNDARY_MAX_SECONDS
        )
        if prefix_is_edge and not suffix_is_edge:
            result[start:cut] = [speakers[cut]] * len(prefix_words)
        elif suffix_is_edge and not prefix_is_edge:
            result[cut:end] = [speakers[cut - 1]] * len(suffix_words)
        elif prefix_is_edge and suffix_is_edge:
            if suffix_duration >= prefix_duration * 1.5:
                result[start:cut] = [speakers[cut]] * len(prefix_words)
            elif prefix_duration >= suffix_duration * 1.5:
                result[cut:end] = [speakers[cut - 1]] * len(suffix_words)

    return result


def word_speakers(
    words,
    segments,
    reassigns: list[tuple[float, float, str]] | None = None,
    relabel: dict[str, str] | None = None,
) -> list[str]:
    """Per-word effective speaker label (overlay applied)."""
    reassigns = reassigns or []
    relabel = relabel or {}
    seg_starts = [s.start for s in segments]
    out = [assign_speaker(w.start, w.end, seg_starts, segments) for w in words]
    out = stabilize_speaker_boundaries(words, out)
    effective: list[str] = []
    for w, spk in zip(words, out):
        mid = (w.start + w.end) / 2
        for rs, re, label in reassigns:
            if rs <= mid <= re:
                spk = label
                break
        effective.append(relabel.get(spk, spk))
    return effective


def chunk_cues(words, speakers, max_dur: float = 6.0, max_words: int = 14):
    """Group words into subtitle cues that break on speaker change / length."""
    cues: list[tuple[float, float, str, str]] = []  # start, end, speaker, text
    start = end = None
    spk = None
    buf: list[str] = []

    def flush():
        if buf:
            cues.append((start, end, spk, "".join(buf).strip()))

    for w, s in zip(words, speakers):
        if (
            spk is None
            or s != spk
            or (w.end - start) > max_dur
            or len(buf) >= max_words
        ):
            flush()
            start, end, spk, buf = w.start, w.end, s, [w.text]
        else:
            end = w.end
            buf.append(w.text)
    flush()
    return cues


def build_utterances(
    words,
    segments,
    reassigns: list[tuple[float, float, str]] | None = None,
    relabel: dict[str, str] | None = None,
) -> list[Utterance]:
    """Group consecutive words sharing a speaker into utterances.

    Stage D overlay:
      * ``reassigns``: list of (start, end, speaker) that force a speaker for any
        word whose midpoint falls in the range (manual segment reassignment).
      * ``relabel``: maps raw speaker labels to a merged label (speaker merge).
    """
    if not words:
        return []
    reassigns = reassigns or []
    relabel = relabel or {}
    seg_starts = [s.start for s in segments]
    speakers = [assign_speaker(w.start, w.end, seg_starts, segments) for w in words]
    speakers = stabilize_speaker_boundaries(words, speakers)
    utterances: list[Utterance] = []
    cur: Utterance | None = None
    for w, spk in zip(words, speakers):
        mid = (w.start + w.end) / 2
        for rs, re, label in reassigns:
            if rs <= mid <= re:
                spk = label
                break
        spk = relabel.get(spk, spk)
        if cur is None or cur.speaker != spk:
            if cur is not None:
                cur.text = cur.text.strip()
                utterances.append(cur)
            cur = Utterance(speaker=spk, start=w.start, end=w.end, text=w.text)
        else:
            cur.end = w.end
            cur.text += w.text
    if cur is not None:
        cur.text = cur.text.strip()
        utterances.append(cur)
    return utterances

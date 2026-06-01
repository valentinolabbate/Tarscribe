"""Stage C: combine ASR words with diarization segments into a speaker transcript.

Cheap and deterministic, so it can be recomputed instantly whenever the active
diarization run or manual speaker labels change.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass


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
    out: list[str] = []
    for w in words:
        spk = assign_speaker(w.start, w.end, seg_starts, segments)
        mid = (w.start + w.end) / 2
        for rs, re, label in reassigns:
            if rs <= mid <= re:
                spk = label
                break
        out.append(relabel.get(spk, spk))
    return out


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
    utterances: list[Utterance] = []
    cur: Utterance | None = None
    for w in words:
        spk = assign_speaker(w.start, w.end, seg_starts, segments)
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

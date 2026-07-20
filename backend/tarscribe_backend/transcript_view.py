"""The single, non-destructive read model for a recording transcript."""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from .models import Transcript, TranscriptCorrection, Word


@dataclass(frozen=True)
class EffectiveWord:
    start: float
    end: float
    text: str
    confidence: float | None
    source_start_idx: int
    source_end_idx: int
    raw_text: str
    correction_id: int | None = None


@dataclass(frozen=True)
class TranscriptSnapshot:
    transcript: Transcript
    words: list[Word]


def load_raw_words(session: Session, recording_id: int) -> TranscriptSnapshot | None:
    """Return the newest non-empty Stage-A transcript and its immutable raw words."""
    transcripts = session.exec(
        select(Transcript)
        .where(Transcript.recording_id == recording_id)
        .order_by(Transcript.created_at.desc(), Transcript.id.desc())
    ).all()
    for transcript in transcripts:
        words = session.exec(
            select(Word).where(Word.transcript_id == transcript.id).order_by(Word.idx)
        ).all()
        if words:
            return TranscriptSnapshot(transcript=transcript, words=words)
    return None


def apply_text_overlays(
    words: list[Word], corrections: list[TranscriptCorrection]
) -> list[EffectiveWord]:
    """Collapse active corrected raw ranges into effective synthetic words.

    Corrections are checked when written, nevertheless this reader defensively
    ignores malformed/overlapping rows so a damaged historic DB cannot corrupt
    the transcript view.
    """
    by_start = {
        correction.start_word_idx: correction
        for correction in corrections
        if correction.status == "active"
    }
    result: list[EffectiveWord] = []
    index = 0
    while index < len(words):
        word = words[index]
        correction = by_start.get(word.idx)
        if correction is None or correction.end_word_idx < word.idx:
            result.append(
                EffectiveWord(
                    start=word.start,
                    end=word.end,
                    text=word.text,
                    confidence=word.confidence,
                    source_start_idx=word.idx,
                    source_end_idx=word.idx,
                    raw_text=word.text,
                )
            )
            index += 1
            continue
        span = [item for item in words[index:] if item.idx <= correction.end_word_idx]
        if not span or span[0].idx != correction.start_word_idx or span[-1].idx != correction.end_word_idx:
            result.append(
                EffectiveWord(
                    start=word.start,
                    end=word.end,
                    text=word.text,
                    confidence=word.confidence,
                    source_start_idx=word.idx,
                    source_end_idx=word.idx,
                    raw_text=word.text,
                )
            )
            index += 1
            continue
        result.append(
            EffectiveWord(
                start=span[0].start,
                end=span[-1].end,
                text=correction.corrected_text,
                confidence=min((item.confidence for item in span if item.confidence is not None), default=None),
                source_start_idx=span[0].idx,
                source_end_idx=span[-1].idx,
                raw_text="".join(item.text for item in span),
                correction_id=correction.id,
            )
        )
        index += len(span)
    return result


def load_effective_words(session: Session, recording_id: int) -> tuple[TranscriptSnapshot, list[EffectiveWord]] | None:
    snapshot = load_raw_words(session, recording_id)
    if snapshot is None:
        return None
    corrections = session.exec(
        select(TranscriptCorrection)
        .where(
            TranscriptCorrection.recording_id == recording_id,
            TranscriptCorrection.status == "active",
        )
        .order_by(TranscriptCorrection.start_word_idx)
    ).all()
    return snapshot, apply_text_overlays(snapshot.words, corrections)


def effective_text(words: list[EffectiveWord]) -> str:
    return "".join(word.text for word in words).strip()

"""Local, deterministic quality signals for a completed Stage-A transcript."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .transcript_view import EffectiveWord

CRITICAL_CONFIDENCE = 0.35
REVIEW_CONFIDENCE = 0.60
NOTICE_CONFIDENCE = 0.72


@dataclass(frozen=True)
class QualityIssue:
    issue_id: str
    reason_codes: list[str]
    severity: str
    start_word_idx: int
    end_word_idx: int
    start_sec: float
    end_sec: float
    raw_text: str
    effective_text: str
    min_confidence: float | None
    mean_confidence: float | None
    quality_score: float | None
    correction_id: int | None = None

    def serialize(self) -> dict:
        return asdict(self)


def _is_content(text: str) -> bool:
    return any(char.isalnum() for char in text)


def analyze_words(
    words: list[EffectiveWord], *, transcript_id: int, revision: int
) -> list[QualityIssue]:
    """Mark only real word-level confidence signals; ``None`` is not low confidence."""
    issues: list[QualityIssue] = []
    for word in words:
        if word.correction_id is not None or not _is_content(word.raw_text) or word.confidence is None:
            continue
        confidence = min(1.0, max(0.0, word.confidence))
        if confidence >= REVIEW_CONFIDENCE:
            continue
        severity = "critical" if confidence < CRITICAL_CONFIDENCE else "review"
        issue_id = f"{transcript_id}:{revision}:{word.source_start_idx}:{word.source_end_idx}:confidence"
        issues.append(
            QualityIssue(
                issue_id=issue_id,
                reason_codes=["low_confidence"],
                severity=severity,
                start_word_idx=word.source_start_idx,
                end_word_idx=word.source_end_idx,
                start_sec=word.start,
                end_sec=word.end,
                raw_text=word.raw_text,
                effective_text=word.text,
                min_confidence=confidence,
                mean_confidence=confidence,
                quality_score=confidence,
                correction_id=word.correction_id,
            )
        )
    return issues


def quality_summary(words: list[EffectiveWord], issues: list[QualityIssue]) -> dict:
    confidences = [word.confidence for word in words if word.confidence is not None]
    return {
        "coverage": "word_confidence" if confidences else "unavailable",
        "open_count": len(issues),
        "critical_count": sum(issue.severity == "critical" for issue in issues),
        "unknown_confidence_count": len(words) - len(confidences),
    }

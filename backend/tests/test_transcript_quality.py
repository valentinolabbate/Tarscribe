from tarscribe_backend.transcript_quality import analyze_words, quality_summary
from tarscribe_backend.transcript_view import EffectiveWord


def _word(text: str, confidence: float | None, index: int = 0) -> EffectiveWord:
    return EffectiveWord(
        start=float(index),
        end=float(index + 1),
        text=text,
        raw_text=text,
        confidence=confidence,
        source_start_idx=index,
        source_end_idx=index,
    )


def test_missing_confidence_is_coverage_gap_not_a_low_confidence_issue():
    words = [_word(" EPEX", None), _word(" Spot", 0.42, 1), _word(".", 0.02, 2)]

    issues = analyze_words(words, transcript_id=7, revision=0)

    assert [issue.raw_text for issue in issues] == [" Spot"]
    assert issues[0].severity == "review"
    assert quality_summary(words, issues) == {
        "coverage": "word_confidence",
        "open_count": 1,
        "critical_count": 0,
        "unknown_confidence_count": 1,
    }


def test_very_low_confidence_is_critical_and_punctuation_is_ignored():
    issues = analyze_words(
        [_word(" Epic", 0.21), _word("!", 0.01, 1)], transcript_id=3, revision=2
    )

    assert len(issues) == 1
    assert issues[0].severity == "critical"
    assert issues[0].issue_id == "3:2:0:0:confidence"

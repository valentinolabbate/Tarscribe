from types import SimpleNamespace

from tarscribe_backend.ml.alignment import word_speakers
from tarscribe_backend.ml.diarization import SpeakerSegment
from tarscribe_backend.ml.live_diarization import LiveSegment, assign_speakers_to_words


def _word(start, end, text):
    return SimpleNamespace(start=start, end=end, text=text)


def test_moves_sentence_end_fragment_to_previous_speaker():
    words = [
        _word(0.0, 0.2, " Der"),
        _word(0.2, 0.4, " hat"),
        _word(0.4, 0.6, " im"),
        _word(0.6, 1.0, " Orgament"),
        _word(1.0, 1.5, " rumgewurschtelt,"),
        _word(1.5, 1.7, " ne?"),
        _word(1.7, 1.9, " Ja,"),
        _word(1.9, 2.1, " ich"),
        _word(2.1, 2.4, " weiß."),
    ]
    segments = [
        SpeakerSegment(0.0, 1.0, "Christina"),
        SpeakerSegment(1.0, 2.4, "Stefan"),
    ]

    assert word_speakers(words, segments) == [
        "Christina",
        "Christina",
        "Christina",
        "Christina",
        "Christina",
        "Christina",
        "Stefan",
        "Stefan",
        "Stefan",
    ]


def test_moves_sentence_start_fragment_to_next_speaker():
    words = [
        _word(0.0, 0.5, " Vorher."),
        _word(0.5, 0.7, " Aber"),
        _word(0.7, 0.9, " die"),
        _word(0.9, 1.2, " Tools"),
        _word(1.2, 1.4, " tauchen"),
        _word(1.4, 1.7, " auf."),
    ]
    segments = [
        SpeakerSegment(0.0, 0.9, "Stefan"),
        SpeakerSegment(0.9, 1.7, "Christina"),
    ]

    assert word_speakers(words, segments) == [
        "Stefan",
        "Christina",
        "Christina",
        "Christina",
        "Christina",
        "Christina",
    ]


def test_keeps_short_backchannel_as_real_speaker_turn():
    words = [
        _word(0.0, 0.25, " Das"),
        _word(0.25, 0.5, " passt"),
        _word(0.5, 0.75, " Okay,"),
        _word(0.75, 0.95, " ja."),
    ]
    segments = [
        SpeakerSegment(0.0, 0.5, "Christina"),
        SpeakerSegment(0.5, 0.95, "Stefan"),
    ]

    assert word_speakers(words, segments) == [
        "Christina",
        "Christina",
        "Stefan",
        "Stefan",
    ]


def test_manual_reassignment_wins_after_boundary_stabilization():
    words = [
        _word(0.0, 0.3, " Ein"),
        _word(0.3, 0.6, " ganzer"),
        _word(0.6, 0.9, " Satz"),
        _word(0.9, 1.1, " hier."),
    ]
    segments = [
        SpeakerSegment(0.0, 0.9, "Christina"),
        SpeakerSegment(0.9, 1.1, "Stefan"),
    ]

    assert word_speakers(words, segments, reassigns=[(0.9, 1.1, "Stefan")]) == [
        "Christina",
        "Christina",
        "Christina",
        "Stefan",
    ]


def test_live_alignment_uses_the_same_boundary_stabilization():
    words = [
        {"start": 0.0, "end": 0.3, "text": " Das"},
        {"start": 0.3, "end": 0.6, "text": " ist"},
        {"start": 0.6, "end": 0.9, "text": " ein"},
        {"start": 0.9, "end": 1.2, "text": " Satz"},
        {"start": 1.2, "end": 1.5, "text": " hier."},
    ]
    segments = [
        LiveSegment(0.0, 1.2, "live-speaker-1"),
        LiveSegment(1.2, 1.5, "live-speaker-2"),
    ]

    aligned = assign_speakers_to_words(words, segments)

    assert [word["speaker_id"] for word in aligned] == ["live-speaker-1"] * 5

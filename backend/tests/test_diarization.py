from __future__ import annotations

from types import SimpleNamespace

from tarscribe_backend.ml.diarization import DiarizationBackend


class _Annotation:
    def __init__(self, tracks):
        self.tracks = tracks

    def itertracks(self, *, yield_label):
        assert yield_label is True
        return iter(self.tracks)


def _turn(start, end):
    return SimpleNamespace(start=start, end=end)


def _backend(monkeypatch, output):
    def pipeline(_audio, **_kwargs):
        return output

    backend = DiarizationBackend("token")
    monkeypatch.setattr(backend, "_ensure_pipeline", lambda: pipeline)
    monkeypatch.setattr(
        "tarscribe_backend.ml.diarization._load_waveform",
        lambda _path: {"waveform": object(), "sample_rate": 16000},
    )
    return backend


def test_diarize_prefers_exclusive_transcript_alignment(monkeypatch, tmp_path):
    regular = _Annotation(
        [
            (_turn(0.0, 1.2), None, "SPEAKER_00"),
            (_turn(0.9, 2.0), None, "SPEAKER_01"),
        ]
    )
    exclusive = _Annotation(
        [
            (_turn(0.0, 1.0), None, "SPEAKER_00"),
            (_turn(1.0, 2.0), None, "SPEAKER_01"),
        ]
    )
    output = SimpleNamespace(
        speaker_diarization=regular,
        exclusive_speaker_diarization=exclusive,
    )

    segments = _backend(monkeypatch, output).diarize(tmp_path / "audio.wav")

    assert [(s.start, s.end, s.speaker) for s in segments] == [
        (0.0, 1.0, "SPEAKER_00"),
        (1.0, 2.0, "SPEAKER_01"),
    ]


def test_diarize_falls_back_to_regular_annotation(monkeypatch, tmp_path):
    annotation = _Annotation([(_turn(0.0, 2.0), None, "SPEAKER_00")])

    segments = _backend(monkeypatch, annotation).diarize(tmp_path / "audio.wav")

    assert [(s.start, s.end, s.speaker) for s in segments] == [
        (0.0, 2.0, "SPEAKER_00")
    ]

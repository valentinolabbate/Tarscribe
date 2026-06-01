"""Speaker diarization via pyannote (best open model: community-1).

Exposes user-tunable parameters so the pipeline can be re-run after the fact
without re-transcribing (see the staged-pipeline design in the project plan).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"

ProgressCb = Callable[[float, str], None]


@dataclass
class DiarizationParams:
    # Speaker count control. Leave all None for fully automatic.
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None
    # Clustering sensitivity: higher merges more (fewer speakers), lower splits.
    clustering_threshold: float | None = None
    # Minimum silence (s) to cut a speaker turn.
    min_duration_off: float | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class SpeakerSegment:
    start: float
    end: float
    speaker: str


class DiarizationBackend:
    name = "pyannote"

    def __init__(self, hf_token: str, model_id: str = DEFAULT_MODEL, device: str = "cpu") -> None:
        self.hf_token = hf_token
        self.model_id = model_id
        self.device = device
        self._pipeline = None

    def _ensure_pipeline(self):
        if self._pipeline is None:
            import torch
            from pyannote.audio import Pipeline

            try:
                pipeline = Pipeline.from_pretrained(self.model_id, token=self.hf_token)
            except TypeError:
                # Older pyannote.audio used use_auth_token.
                pipeline = Pipeline.from_pretrained(
                    self.model_id, use_auth_token=self.hf_token
                )
            if pipeline is None:
                raise RuntimeError(
                    "pyannote-Pipeline konnte nicht geladen werden — Token ungültig oder "
                    "Modell-Lizenz nicht akzeptiert."
                )
            try:
                pipeline.to(torch.device(self.device))
            except Exception as exc:
                print(f"Diarisierungs-Pipeline: {self.device}-Initialisierung fehlgeschlagen: {exc}")
                pipeline.to(torch.device("cpu"))
                self.device = "cpu"
            self._pipeline = pipeline
        return self._pipeline

    def _apply_hyperparams(self, pipeline, params: DiarizationParams) -> None:
        """Best-effort tuning of clustering threshold / min silence.

        Pipeline internals vary by model version, so we try and ignore failures.
        """
        if params.clustering_threshold is None and params.min_duration_off is None:
            return
        try:
            current = dict(pipeline.parameters(instantiated=True))
        except Exception:
            return
        if params.clustering_threshold is not None and "clustering" in current:
            current["clustering"]["threshold"] = float(params.clustering_threshold)
        if params.min_duration_off is not None and "segmentation" in current:
            current["segmentation"]["min_duration_off"] = float(params.min_duration_off)
        try:
            pipeline.instantiate(current)
        except Exception:
            pass

    def diarize(
        self,
        audio_path: Path,
        params: DiarizationParams | None = None,
        progress: ProgressCb | None = None,
    ) -> list[SpeakerSegment]:
        params = params or DiarizationParams()
        pipeline = self._ensure_pipeline()
        self._apply_hyperparams(pipeline, params)

        if progress:
            progress(0.05, "Diarisierungs-Modell geladen…")

        hook = _make_hook(progress) if progress else None

        call_kwargs: dict = {}
        if params.num_speakers is not None:
            call_kwargs["num_speakers"] = params.num_speakers
        else:
            if params.min_speakers is not None:
                call_kwargs["min_speakers"] = params.min_speakers
            if params.max_speakers is not None:
                call_kwargs["max_speakers"] = params.max_speakers
        if hook is not None:
            call_kwargs["hook"] = hook

        output = pipeline(_load_waveform(audio_path), **call_kwargs)

        # Newer pipelines (e.g. community-1) return a DiarizeOutput wrapper; the
        # classic pipelines return an Annotation directly.
        annotation = getattr(output, "speaker_diarization", output)

        segments: list[SpeakerSegment] = []
        for turn, _, speaker in annotation.itertracks(yield_label=True):
            segments.append(SpeakerSegment(start=turn.start, end=turn.end, speaker=str(speaker)))
        segments.sort(key=lambda s: s.start)
        if progress:
            progress(1.0, "Diarisierung fertig")
        return segments


def _make_hook(progress: ProgressCb):
    """Adapt pyannote's hook protocol to our (fraction, message) callback."""

    def hook(step_name, step_artifact, file=None, total=None, completed=None):  # noqa: ANN001
        if total and completed is not None:
            frac = 0.05 + 0.9 * (completed / total)
            progress(min(0.98, frac), f"Diarisiere… ({step_name})")

    return hook


def _load_waveform(audio_path: Path) -> dict:
    """Load normalized audio once so pyannote does not decode the file repeatedly."""
    import soundfile as sf
    import torch

    samples, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
    waveform = torch.from_numpy(samples.T.copy())
    return {"waveform": waveform, "sample_rate": sample_rate}

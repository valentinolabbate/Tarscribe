"""Speaker embeddings (voiceprints) via ECAPA-TDNN.

Used to (a) enroll known speakers from a voice sample and (b) auto-match
diarized speaker clusters to the known-speaker library by cosine similarity.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
# How much representative audio (s) to feed the embedder per speaker.
MAX_ENROLL_SECONDS = 20.0

_model = None


def _get_model():
    """Load the ECAPA-TDNN embedder via speechbrain directly.

    We avoid pyannote's PretrainedSpeakerEmbedding wrapper because it passes a
    ``token`` kwarg that newer speechbrain releases reject.
    """
    global _model
    if _model is None:
        from speechbrain.inference.speaker import EncoderClassifier

        from ..config import get_settings
        from ..hardware import detect_hardware

        savedir = str(get_settings().models_dir / "ecapa")
        device = detect_hardware().recommended_device
        for dev in (device, "cpu"):
            try:
                _model = EncoderClassifier.from_hparams(
                    source=EMBEDDING_MODEL, savedir=savedir, run_opts={"device": dev}
                )
                break
            except Exception:
                continue
    return _model


def unload_model() -> None:
    """Drop the cached embedding model so its memory can be reclaimed."""
    global _model
    _model = None


def _load_wav(path: Path) -> np.ndarray:
    """Load a 16 kHz mono wav as float32 mono samples."""
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data


def _embed_waveform(samples: np.ndarray) -> np.ndarray:
    import torch

    model = _get_model()
    if samples.size == 0:
        raise ValueError("Leeres Audio für Embedding")
    wav = torch.from_numpy(samples).float().reshape(1, -1)  # (batch, time)
    with torch.no_grad():
        emb = model.encode_batch(wav)  # (batch, 1, dim)
    emb = emb.detach().cpu().numpy().astype(np.float32).reshape(-1)
    return _normalize(emb)


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def embed_file(path: Path) -> np.ndarray:
    """Embedding for a whole audio file."""
    return _embed_waveform(_load_wav(path))


def embed_speaker_segments(audio_path: Path, segments: list[tuple[float, float]]) -> np.ndarray:
    """Build a voiceprint from the most representative segments of one speaker."""
    samples = _load_wav(audio_path)
    # Prefer the longest segments, up to MAX_ENROLL_SECONDS total.
    ordered = sorted(segments, key=lambda s: s[1] - s[0], reverse=True)
    chunks: list[np.ndarray] = []
    total = 0.0
    for start, end in ordered:
        if total >= MAX_ENROLL_SECONDS:
            break
        i0 = max(0, int(start * SAMPLE_RATE))
        i1 = min(len(samples), int(end * SAMPLE_RATE))
        if i1 > i0:
            chunks.append(samples[i0:i1])
            total += (i1 - i0) / SAMPLE_RATE
    if not chunks:
        raise ValueError("Keine Audio-Segmente für diesen Sprecher")
    return _embed_waveform(np.concatenate(chunks))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(_normalize(a), _normalize(b)))


def to_blob(v: np.ndarray) -> bytes:
    return np.asarray(v, dtype=np.float32).tobytes()


def from_blob(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)


def update_mean(existing: np.ndarray | None, count: int, new: np.ndarray) -> np.ndarray:
    """Running mean of L2-normalized embeddings, re-normalized."""
    if existing is None or count <= 0:
        return _normalize(new)
    merged = (existing * count + new) / (count + 1)
    return _normalize(merged)

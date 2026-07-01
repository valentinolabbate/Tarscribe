"""PCM chunk validation and WAV extraction helpers for live recording sessions."""

from __future__ import annotations

import wave
from pathlib import Path
from typing import NamedTuple


class ChunkResult(NamedTuple):
    accepted: bool
    last_sequence_number: int
    received_duration_sec: float
    reason: str = ""


def validate_and_append_chunk(
    pcm_path: Path,
    chunk_data: bytes,
    sequence_number: int,
    expected_next_sequence: int,
    sample_rate: int,
    channels: int,
) -> ChunkResult:
    bytes_per_sample = 2 * channels
    total_bytes = pcm_path.stat().st_size if pcm_path.exists() else 0
    current_duration = (total_bytes // bytes_per_sample) / sample_rate if bytes_per_sample else 0.0

    if sequence_number < expected_next_sequence:
        return ChunkResult(
            accepted=True,
            last_sequence_number=expected_next_sequence - 1,
            received_duration_sec=current_duration,
            reason="already_processed",
        )

    if sequence_number > expected_next_sequence:
        return ChunkResult(
            accepted=False,
            last_sequence_number=expected_next_sequence - 1,
            received_duration_sec=current_duration,
            reason=f"gap: expected {expected_next_sequence}, got {sequence_number}",
        )

    if not chunk_data or len(chunk_data) % bytes_per_sample != 0:
        return ChunkResult(
            accepted=False,
            last_sequence_number=expected_next_sequence - 1,
            received_duration_sec=current_duration,
            reason="invalid_chunk_size",
        )

    pcm_path.parent.mkdir(parents=True, exist_ok=True)
    with open(pcm_path, "ab") as f:
        f.write(chunk_data)

    total_bytes = pcm_path.stat().st_size
    duration = (total_bytes // bytes_per_sample) / sample_rate

    return ChunkResult(
        accepted=True,
        last_sequence_number=sequence_number,
        received_duration_sec=duration,
    )


def cleanup_session_dir(pcm_path: str | None) -> None:
    if not pcm_path:
        return
    import shutil

    try:
        shutil.rmtree(Path(pcm_path).parent, ignore_errors=True)
    except Exception:
        pass


def build_wav_window(
    pcm_path: Path,
    start_sec: float,
    end_sec: float,
    sample_rate: int,
    channels: int,
    out_path: Path,
) -> bool:
    if not pcm_path.exists():
        return False

    bytes_per_sample = 2 * channels
    total_bytes = pcm_path.stat().st_size
    total_samples = total_bytes // bytes_per_sample

    start_sample = int(start_sec * sample_rate)
    end_sample = min(int(end_sec * sample_rate), total_samples)

    if start_sample >= end_sample:
        return False

    with open(pcm_path, "rb") as f:
        f.seek(start_sample * bytes_per_sample)
        data = f.read((end_sample - start_sample) * bytes_per_sample)

    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(data)

    return True

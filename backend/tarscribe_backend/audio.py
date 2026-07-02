"""Audio ingestion helpers built on ffmpeg/ffprobe.

We normalize every uploaded/recorded file to 16 kHz mono PCM wav, which is what
the ASR and diarization models expect, and keep the original filename for export.
"""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .media_tools import media_tool_path

TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1


class AudioError(RuntimeError):
    pass


def _resolve(tool: str) -> str:
    path = media_tool_path(tool)
    if not path:
        raise AudioError(
            f"'{tool}' wurde nicht gefunden. Bitte ffmpeg installieren oder mit der App bündeln."
        )
    return path


def probe_duration(path: Path) -> float:
    """Return media duration in seconds, or 0.0 if unknown.

    Falls back to reading the audio header directly (soundfile) when ffprobe
    fails or reports nothing — for the normalized wav files we feed to the ASR
    backends this is bullet-proof and keeps progress / chunking working even if
    ffprobe is flaky.
    """
    try:
        ffprobe = _resolve("ffprobe")
        out = subprocess.run(
            [
                ffprobe,
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(out.stdout or "{}")
        duration = float(data.get("format", {}).get("duration", 0.0) or 0.0)
        if duration > 0:
            return duration
    except (AudioError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError):
        pass
    return _soundfile_duration(path)


def compute_waveform_peaks(path: Path, point_count: int) -> tuple[float, list[float]]:
    try:
        with sf.SoundFile(str(path)) as audio:
            total_frames = len(audio)
            duration = total_frames / audio.samplerate if audio.samplerate else 0.0
            frames_per_point = max(1, math.ceil(total_frames / point_count))
            peaks: list[float] = []
            while len(peaks) < point_count * 2:
                samples = audio.read(frames_per_point, dtype="float32", always_2d=True)
                if samples.size == 0:
                    break
                peak = float(np.max(np.abs(samples)))
                peaks.extend((-peak, peak))
    except Exception as exc:
        raise AudioError(f"Wellenform konnte nicht gelesen werden: {exc}") from exc
    return duration, peaks or [0.0, 0.0]


def _soundfile_duration(path: Path) -> float:
    """Duration from the audio header for formats soundfile can read (wav/flac/…)."""
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return info.frames / info.samplerate if info.samplerate else 0.0
    except Exception:  # noqa: BLE001 - unreadable/unsupported format
        return 0.0


def normalize_to_wav(src: Path, dst: Path) -> None:
    """Transcode any input to 16 kHz mono wav at ``dst``."""
    ffmpeg = _resolve("ffmpeg")
    dst.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(src),
            "-ac",
            str(TARGET_CHANNELS),
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-vn",
            str(dst),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AudioError(f"ffmpeg konnte die Datei nicht konvertieren:\n{proc.stderr[-800:]}")


def mix_to_wav(system_audio: Path, microphone_audio: Path, dst: Path) -> None:
    """Mix native system audio and browser microphone audio into a normalized wav."""
    ffmpeg = _resolve("ffmpeg")
    dst.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(system_audio),
            "-i",
            str(microphone_audio),
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:duration=longest:normalize=1[a]",
            "-map",
            "[a]",
            "-ac",
            str(TARGET_CHANNELS),
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-vn",
            str(dst),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AudioError(f"ffmpeg konnte Systemaudio und Mikrofon nicht mischen:\n{proc.stderr[-800:]}")


def slice_to_wav(src: Path, dst: Path, start: float, end: float) -> None:
    """Extract ``[start, end]`` seconds of ``src`` into a 16 kHz mono wav.

    Used for speaker enrollment from an existing recording.
    """
    ffmpeg = _resolve("ffmpeg")
    dst.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.0, end - start)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(src),
            "-ac",
            str(TARGET_CHANNELS),
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-vn",
            str(dst),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AudioError(f"ffmpeg-Ausschnitt fehlgeschlagen:\n{proc.stderr[-800:]}")

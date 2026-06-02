"""Audio ingestion helpers built on ffmpeg/ffprobe.

We normalize every uploaded/recorded file to 16 kHz mono PCM wav, which is what
the ASR and diarization models expect, and keep the original filename for export.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

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
    """Return media duration in seconds, or 0.0 if unknown."""
    ffprobe = _resolve("ffprobe")
    try:
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
        return float(data.get("format", {}).get("duration", 0.0) or 0.0)
    except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError):
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

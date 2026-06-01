"""Hardware detection used to pick the best ASR/diarization backend.

Kept dependency-free (no torch import at module load) so the base server starts
light. ML libraries are probed lazily and failures degrade to CPU.
"""

from __future__ import annotations

import platform
from dataclasses import dataclass, asdict
from functools import lru_cache


@dataclass
class HardwareInfo:
    os: str  # "darwin" | "windows" | "linux"
    arch: str  # "arm64" | "x86_64" | ...
    is_apple_silicon: bool
    has_mps: bool
    has_cuda: bool
    cuda_device: str | None
    vram_gb: float | None
    recommended_asr: str  # "parakeet-mlx" | "faster-whisper"
    recommended_device: str  # "mps" | "cuda" | "cpu"
    recommended_precision: str  # "float16" | "int8" | "float32"

    def to_dict(self) -> dict:
        return asdict(self)


def _detect_torch_devices() -> tuple[bool, bool, str | None, float | None]:
    try:
        import torch  # type: ignore

        has_mps = torch.backends.mps.is_available()
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            vram = round(props.total_memory / (1024**3), 1)
            return has_mps, True, name, vram
        return has_mps, False, None, None
    except Exception:
        pass
    return False, False, None, None


@lru_cache
def detect_hardware() -> HardwareInfo:
    os_name = platform.system().lower()  # darwin / windows / linux
    arch = platform.machine().lower()
    is_apple_silicon = os_name == "darwin" and arch in ("arm64", "aarch64")

    has_mps, has_cuda, cuda_device, vram = _detect_torch_devices()

    if is_apple_silicon:
        asr = "parakeet-mlx"
        device = "mps" if has_mps else "cpu"
        precision = "float16" if has_mps else "float32"
    elif has_cuda:
        asr = "faster-whisper"
        device = "cuda"
        precision = "float16"
    else:
        asr = "faster-whisper"
        device = "cpu"
        precision = "int8"

    return HardwareInfo(
        os=os_name,
        arch=arch,
        is_apple_silicon=is_apple_silicon,
        has_mps=has_mps,
        has_cuda=has_cuda,
        cuda_device=cuda_device,
        vram_gb=vram,
        recommended_asr=asr,
        recommended_device=device,
        recommended_precision=precision,
    )

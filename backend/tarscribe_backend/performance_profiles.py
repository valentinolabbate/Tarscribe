"""Performance profiles for ASR and diarization model selection.

Profiles keep the UI user-friendly while still resolving to concrete model and
runtime choices in the backend.
"""

from __future__ import annotations

from typing import Any

DEFAULT_PROFILE = "balanced"
PROFILE_IDS = ("m1_8gb", "balanced", "quality")

DEFAULT_DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"


def normalize_profile(value: Any) -> str:
    if isinstance(value, str) and value in PROFILE_IDS:
        return value
    return DEFAULT_PROFILE


def recommended_profile_for_hardware(hw: Any) -> str:
    """Return the safest default profile for detected hardware."""
    memory_gb = getattr(hw, "memory_gb", None)
    if getattr(hw, "is_apple_silicon", False):
        if memory_gb is not None and memory_gb <= 12:
            return "m1_8gb"
        return "balanced"
    vram_gb = getattr(hw, "vram_gb", None)
    if getattr(hw, "has_cuda", False) and vram_gb is not None and vram_gb >= 16:
        return "quality"
    return "balanced"


def _apple_asr(profile: str) -> dict[str, Any]:
    # Apple Silicon should stay on MLX even for the lowest profile. Smaller
    # chunks reduce peak memory without falling back to CPU.
    if profile == "m1_8gb":
        return {
            "engine": "parakeet-mlx",
            "model_id": "mlx-community/parakeet-tdt-0.6b-v3",
            "chunk_seconds": 60.0,
            "overlap_seconds": 10.0,
        }
    return {
        "engine": "parakeet-mlx",
        "model_id": "mlx-community/parakeet-tdt-0.6b-v3",
        "chunk_seconds": 120.0,
        "overlap_seconds": 15.0,
    }


def _faster_whisper_asr(profile: str, hw: Any) -> dict[str, Any]:
    device = getattr(hw, "recommended_device", "cpu")
    if device not in ("cuda", "cpu"):
        device = "cpu"

    if profile == "m1_8gb":
        model_size = "small"
        compute_type = "int8"
    elif profile == "quality":
        model_size = "large-v3"
        compute_type = "float16" if device == "cuda" else "int8"
    else:
        model_size = "medium"
        compute_type = "float16" if device == "cuda" else "int8"

    return {
        "engine": "faster-whisper",
        "model_size": model_size,
        "device": device,
        "compute_type": compute_type,
    }


def resolve_asr_selection(prefs: dict[str, Any], hw: Any, override: str | None = None) -> dict[str, Any]:
    """Resolve settings + hardware into a concrete ASR backend configuration."""
    profile = normalize_profile(prefs.get("performance_profile"))
    engine_override = override or prefs.get("asr_override")
    if engine_override:
        profile = "balanced"

    if getattr(hw, "is_apple_silicon", False) and (engine_override in (None, "parakeet-mlx")):
        selection = _apple_asr(profile)
    else:
        selection = _faster_whisper_asr(profile, hw)
        if engine_override in ("faster-whisper", "parakeet-mlx"):
            selection["engine"] = engine_override

    selection["profile"] = profile
    return selection


def resolve_diarization_selection(prefs: dict[str, Any], hw: Any) -> dict[str, Any]:
    """Resolve settings + hardware into a diarization runtime configuration."""
    profile = normalize_profile(prefs.get("performance_profile"))
    model_id = prefs.get("diarization_model") or DEFAULT_DIARIZATION_MODEL
    device = getattr(hw, "recommended_device", "cpu")
    if device not in ("mps", "cuda", "cpu"):
        device = "cpu"
    return {
        "profile": profile,
        "model_id": model_id,
        "device": device,
        "speaker_matching_enabled": profile != "m1_8gb",
    }

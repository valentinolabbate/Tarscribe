from __future__ import annotations

from types import SimpleNamespace

from tarscribe_backend.performance_profiles import (
    recommended_profile_for_hardware,
    resolve_asr_selection,
    resolve_diarization_selection,
)


def _apple_m1_8gb():
    return SimpleNamespace(
        is_apple_silicon=True,
        has_cuda=False,
        recommended_device="mps",
        memory_gb=8.0,
        vram_gb=None,
    )


def test_m1_8gb_profile_keeps_apple_gpu_asr_and_diarization():
    hw = _apple_m1_8gb()

    asr = resolve_asr_selection({"performance_profile": "m1_8gb"}, hw)
    diarization = resolve_diarization_selection({"performance_profile": "m1_8gb"}, hw)

    assert recommended_profile_for_hardware(hw) == "m1_8gb"
    assert asr["engine"] == "parakeet-mlx"
    assert asr["chunk_seconds"] == 60.0
    assert diarization["device"] == "mps"
    assert diarization["speaker_matching_enabled"] is False


def test_quality_profile_uses_larger_faster_whisper_on_cuda():
    hw = SimpleNamespace(
        is_apple_silicon=False,
        has_cuda=True,
        recommended_device="cuda",
        memory_gb=64.0,
        vram_gb=24.0,
    )

    asr = resolve_asr_selection({"performance_profile": "quality"}, hw)

    assert recommended_profile_for_hardware(hw) == "quality"
    assert asr["engine"] == "faster-whisper"
    assert asr["model_size"] == "large-v3"
    assert asr["compute_type"] == "float16"

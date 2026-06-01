"""Model memory lifecycle.

Models are loaded lazily on first use and explicitly unloaded once a job's
pipeline has run, so the app does not keep several GB resident while idle.
"""

from __future__ import annotations

import gc
import threading

# Serialises access to the shared ASR singleton.
# Final jobs acquire it blocking; live analysis acquires it non-blocking (skip on contention).
asr_lock = threading.Lock()

# Same pattern for the pyannote diarization pipeline.
diar_lock = threading.Lock()


def release_memory() -> None:
    """Force GC and return cached device memory to the OS (MPS / CUDA / MLX)."""
    gc.collect()
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        import mlx.core as mx

        # Frees MLX's Metal buffer cache (parakeet / mlx-whisper).
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        elif hasattr(mx, "metal") and hasattr(mx.metal, "clear_cache"):
            mx.metal.clear_cache()
    except Exception:
        pass


def unload_all() -> None:
    """Drop every cached model and free memory. Safe to call repeatedly."""
    try:
        from .asr import factory

        factory.unload_backend()
    except Exception:
        pass
    try:
        from . import embedding

        embedding.unload_model()
    except Exception:
        pass
    release_memory()

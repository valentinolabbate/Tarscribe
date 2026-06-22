"""Local model cache inspection without triggering downloads."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..config import get_settings
from ..hardware import detect_hardware
from ..performance_profiles import (
    DEFAULT_DIARIZATION_MODEL,
    DEFAULT_MLX_WHISPER_MODEL,
    QUALITY_MLX_WHISPER_MODEL,
    resolve_asr_selection,
    resolve_diarization_selection,
)
from ..settings_store import load_prefs
from .embedding import EMBEDDING_MODEL

PARAKEET_DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
MLX_WHISPER_REQUIRED_FILES = {
    DEFAULT_MLX_WHISPER_MODEL: ("config.json", "weights.safetensors"),
    QUALITY_MLX_WHISPER_MODEL: ("config.json", "weights.npz"),
    "mlx-community/distil-whisper-large-v3": ("config.json", "weights.npz"),
}
EMBEDDING_RUNTIME_MEMORY_GB = (0.3, 0.7)

ASR_CANDIDATES = (
    {
        "engine": "parakeet-mlx",
        "model": PARAKEET_DEFAULT_MODEL,
        "label": "Parakeet MLX",
        "repo_id": PARAKEET_DEFAULT_MODEL,
        "required_files": ("config.json", "model.safetensors"),
    },
    {
        "engine": "mlx-whisper",
        "model": DEFAULT_MLX_WHISPER_MODEL,
        "label": "MLX Whisper Large v3 Turbo",
        "repo_id": DEFAULT_MLX_WHISPER_MODEL,
        "required_files": MLX_WHISPER_REQUIRED_FILES[DEFAULT_MLX_WHISPER_MODEL],
    },
    {
        "engine": "mlx-whisper",
        "model": QUALITY_MLX_WHISPER_MODEL,
        "label": "MLX Whisper Large v3",
        "repo_id": QUALITY_MLX_WHISPER_MODEL,
        "required_files": MLX_WHISPER_REQUIRED_FILES[QUALITY_MLX_WHISPER_MODEL],
    },
    {
        "engine": "mlx-whisper",
        "model": "mlx-community/distil-whisper-large-v3",
        "label": "MLX Distil Large v3",
        "repo_id": "mlx-community/distil-whisper-large-v3",
        "required_files": MLX_WHISPER_REQUIRED_FILES["mlx-community/distil-whisper-large-v3"],
    },
    {
        "engine": "faster-whisper",
        "model": "small",
        "label": "Whisper Small",
        "repo_id": "Systran/faster-whisper-small",
        "required_files": ("config.json", "model.bin"),
    },
    {
        "engine": "faster-whisper",
        "model": "medium",
        "label": "Whisper Medium",
        "repo_id": "Systran/faster-whisper-medium",
        "required_files": ("config.json", "model.bin"),
    },
    {
        "engine": "faster-whisper",
        "model": "large-v3",
        "label": "Whisper Large v3",
        "repo_id": "Systran/faster-whisper-large-v3",
        "required_files": ("config.json", "model.bin"),
    },
    {
        "engine": "faster-whisper",
        "model": "distil-large-v3",
        "label": "Distil Large v3",
        "repo_id": "Systran/faster-distil-whisper-large-v3",
        "required_files": ("config.json", "model.bin"),
    },
)

DIARIZATION_CANDIDATES = (
    {
        "model": DEFAULT_DIARIZATION_MODEL,
        "label": "Community 1",
        "repo_id": DEFAULT_DIARIZATION_MODEL,
        "required_files": ("config.yaml",),
    },
    {
        "model": "pyannote/speaker-diarization-3.1",
        "label": "Pyannote 3.1",
        "repo_id": "pyannote/speaker-diarization-3.1",
        "required_files": ("config.yaml",),
    },
    {
        "model": "pyannote/speaker-diarization-3.0",
        "label": "Pyannote 3.0",
        "repo_id": "pyannote/speaker-diarization-3.0",
        "required_files": ("config.yaml",),
    },
)

FASTER_WHISPER_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "base": "Systran/faster-whisper-base",
    "base.en": "Systran/faster-whisper-base.en",
    "small": "Systran/faster-whisper-small",
    "small.en": "Systran/faster-whisper-small.en",
    "medium": "Systran/faster-whisper-medium",
    "medium.en": "Systran/faster-whisper-medium.en",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large": "Systran/faster-whisper-large-v3",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-large-v2": "Systran/faster-distil-whisper-large-v2",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
}


def model_status_payload() -> dict[str, Any]:
    settings = get_settings()
    prefs = load_prefs()
    hw = detect_hardware()

    asr_selection = resolve_asr_selection(prefs, hw)
    diarization_selection = resolve_diarization_selection(prefs, hw)

    items: list[dict[str, Any]] = []
    for candidate in _asr_candidates(asr_selection):
        items.append(_asr_status(candidate, active=_is_active_asr(candidate, asr_selection)))
    for candidate in _diarization_candidates(diarization_selection):
        model = str(candidate["model"])
        item = _repo_model_status(
            kind="diarization",
            label=str(candidate["label"]),
            model=model,
            repo_id=str(candidate["repo_id"]),
            required_files=tuple(candidate["required_files"]),
            cache_dirs=[settings.models_dir / "pyannote", None],
            active=model == diarization_selection["model_id"],
        )
        item.update(_memory_fields(_diarization_memory_estimate(model)))
        items.append(item)
    items.append(
        _embedding_status(active=bool(diarization_selection.get("speaker_matching_enabled", True)))
    )

    return {
        "models_dir": str(settings.models_dir),
        "items": _dedupe(items),
    }


def _asr_candidates(selection: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [dict(candidate) for candidate in ASR_CANDIDATES]
    engine = str(selection.get("engine") or "")
    if engine == "parakeet-mlx":
        model = str(selection.get("model_id") or PARAKEET_DEFAULT_MODEL)
        candidates.insert(
            0,
            {
                "engine": engine,
                "model": model,
                "label": "Aktives Transkriptionsmodell",
                "repo_id": model,
                "required_files": ("config.json", "model.safetensors"),
            },
        )
    elif engine == "mlx-whisper":
        model = str(selection.get("model_id") or DEFAULT_MLX_WHISPER_MODEL)
        candidates.insert(
            0,
            {
                "engine": engine,
                "model": model,
                "label": "Aktives Transkriptionsmodell",
                "repo_id": model,
                "required_files": _mlx_whisper_required_files(model),
            },
        )
    elif engine == "faster-whisper":
        model = str(selection.get("model_size") or "medium")
        candidates.insert(
            0,
            {
                "engine": engine,
                "model": model,
                "label": "Aktives Transkriptionsmodell",
                "repo_id": _faster_whisper_repo(model),
                "required_files": ("config.json", "model.bin"),
            },
        )
    return candidates


def _diarization_candidates(selection: dict[str, Any]) -> list[dict[str, Any]]:
    model = str(selection.get("model_id") or DEFAULT_DIARIZATION_MODEL)
    candidates = [
        {
            "model": model,
            "label": "Aktives Diarisierungsmodell",
            "repo_id": model,
            "required_files": ("config.yaml",),
        },
        *(dict(candidate) for candidate in DIARIZATION_CANDIDATES),
    ]
    return candidates


def _asr_status(candidate: dict[str, Any], *, active: bool) -> dict[str, Any]:
    engine = str(candidate["engine"])
    cache_dirs: list[Path | None]
    if engine == "faster-whisper":
        cache_dirs = [get_settings().models_dir, None]
    else:
        cache_dirs = [None]
    item = _repo_model_status(
        kind="asr",
        label=str(candidate["label"]),
        model=str(candidate["model"]),
        repo_id=str(candidate["repo_id"]),
        required_files=tuple(candidate["required_files"]),
        cache_dirs=cache_dirs,
        active=active,
    )
    item["engine"] = engine
    item.update(_memory_fields(_asr_memory_estimate(engine, str(candidate["model"]))))
    return item


def _embedding_status(*, active: bool) -> dict[str, Any]:
    path = get_settings().models_dir / "ecapa"
    downloaded = _dir_has_any(path, ("hyperparams.yaml", "embedding_model.ckpt", "*.ckpt"))
    item = {
        "key": f"embedding:::{EMBEDDING_MODEL}",
        "kind": "embedding",
        "label": "Sprecher-Matching",
        "model": EMBEDDING_MODEL,
        "repo_id": EMBEDDING_MODEL,
        "downloaded": downloaded,
        "status": "downloaded" if downloaded else "missing",
        "path": str(path) if downloaded else None,
        "active": active,
        "note": "Wird für bekannte Sprecher und automatische Zuordnung genutzt.",
    }
    item.update(_memory_fields(EMBEDDING_RUNTIME_MEMORY_GB))
    return item


def _repo_model_status(
    *,
    kind: str,
    label: str,
    model: str,
    repo_id: str,
    required_files: tuple[str, ...],
    cache_dirs: list[Path | None],
    active: bool,
) -> dict[str, Any]:
    local_path = _local_model_path(model)
    if local_path is not None:
        downloaded = local_path.exists()
        return {
            "key": _key(kind, "", model),
            "kind": kind,
            "label": label,
            "model": model,
            "repo_id": repo_id,
            "downloaded": downloaded,
            "status": "downloaded" if downloaded else "missing",
            "path": str(local_path) if downloaded else None,
            "active": active,
        }

    path = _cached_repo_path(repo_id, required_files, cache_dirs)
    downloaded = path is not None
    return {
        "key": _key(kind, "", model),
        "kind": kind,
        "label": label,
        "model": model,
        "repo_id": repo_id,
        "downloaded": downloaded,
        "status": "downloaded" if downloaded else "missing",
        "path": str(path) if path is not None else None,
        "active": active,
    }


def _is_active_asr(candidate: dict[str, Any], selection: dict[str, Any]) -> bool:
    engine = str(selection.get("engine") or "")
    if candidate.get("engine") != engine:
        return False
    if engine in ("parakeet-mlx", "mlx-whisper"):
        return candidate.get("model") == selection.get("model_id")
    if engine == "faster-whisper":
        return candidate.get("model") == selection.get("model_size")
    return False


def _memory_fields(estimate: tuple[float, float]) -> dict[str, float]:
    return {
        "runtime_memory_min_gb": estimate[0],
        "runtime_memory_max_gb": estimate[1],
    }


def _asr_memory_estimate(engine: str, model: str) -> tuple[float, float]:
    normalized = model.lower()
    if engine == "parakeet-mlx":
        return (3.0, 4.5)
    if engine == "mlx-whisper":
        if "large-v3-mlx" in normalized and "turbo" not in normalized:
            return (7.0, 10.0)
        if "turbo" in normalized:
            return (4.5, 6.5)
        if "distil" in normalized:
            return (3.5, 5.5)
        return (5.0, 8.0)
    if "tiny" in normalized or "base" in normalized:
        return (0.5, 1.2)
    if "small" in normalized:
        return (1.0, 2.0)
    if "medium" in normalized:
        return (2.0, 3.5)
    if "distil" in normalized:
        return (3.0, 4.5)
    if "large" in normalized:
        return (4.0, 6.5)
    return (2.0, 4.0)


def _diarization_memory_estimate(model: str) -> tuple[float, float]:
    normalized = model.lower()
    if "community-1" in normalized:
        return (1.5, 2.5)
    return (1.8, 3.0)


def _mlx_whisper_required_files(model: str) -> tuple[str, ...]:
    return MLX_WHISPER_REQUIRED_FILES.get(model, ("config.json", "weights.npz"))


def _faster_whisper_repo(model: str) -> str:
    if model in FASTER_WHISPER_REPOS:
        return FASTER_WHISPER_REPOS[model]
    return model


def _local_model_path(model: str) -> Path | None:
    if not model:
        return None
    path = Path(model).expanduser()
    if path.is_absolute() or model.startswith((".", "~")):
        return path
    if (os.sep in model or (os.altsep and os.altsep in model)) and path.exists():
        return path
    return None


def _cached_repo_path(
    repo_id: str,
    required_files: tuple[str, ...],
    cache_dirs: list[Path | None],
) -> Path | None:
    if not repo_id or "/" not in repo_id:
        return None
    for cache_dir in cache_dirs:
        path = _try_hf_cache(repo_id, required_files, cache_dir)
        if path is not None:
            return path
        path = _scan_hf_cache(repo_id, required_files, cache_dir)
        if path is not None:
            return path
    return None


def _try_hf_cache(
    repo_id: str,
    required_files: tuple[str, ...],
    cache_dir: Path | None,
) -> Path | None:
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return None

    hits: list[Path] = []
    for filename in required_files:
        try:
            found = try_to_load_from_cache(
                repo_id,
                filename,
                cache_dir=str(cache_dir) if cache_dir is not None else None,
            )
        except Exception:
            return None
        if isinstance(found, str) and Path(found).exists():
            hits.append(Path(found))
        else:
            return None
    return hits[0].parent if hits else None


def _scan_hf_cache(
    repo_id: str,
    required_files: tuple[str, ...],
    cache_dir: Path | None,
) -> Path | None:
    roots = [cache_dir] if cache_dir is not None else _default_hf_cache_dirs()
    cache_name = "models--" + repo_id.replace("/", "--")
    for root in roots:
        if root is None:
            continue
        repo_root = root / cache_name
        snapshots = repo_root / "snapshots"
        if not snapshots.exists():
            continue
        for snapshot in snapshots.iterdir():
            if all((snapshot / filename).exists() for filename in required_files):
                return snapshot
    return None


def _default_hf_cache_dirs() -> list[Path]:
    if cache := os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return [Path(cache)]
    if hf_home := os.environ.get("HF_HOME"):
        return [Path(hf_home) / "hub"]
    return [Path.home() / ".cache" / "huggingface" / "hub"]


def _dir_has_any(path: Path, patterns: tuple[str, ...]) -> bool:
    if not path.exists():
        return False
    if path.is_file():
        return True
    return any(any(path.rglob(pattern)) for pattern in patterns)


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        key = _key(str(item.get("kind") or ""), str(item.get("engine") or ""), str(item["model"]))
        item["key"] = key
        if key in result:
            result[key]["active"] = bool(result[key].get("active") or item.get("active"))
            if str(result[key].get("label", "")).startswith("Aktives "):
                continue
        result[key] = item
    return list(result.values())


def _key(kind: str, engine: str, model: str) -> str:
    return f"{kind}:{engine}:{model}"

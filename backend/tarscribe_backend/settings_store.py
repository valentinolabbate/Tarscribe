"""User settings + secret storage.

Non-secret preferences live in ``settings.json`` in the app data dir. Secrets
(the HuggingFace token) go into the OS keychain via ``keyring`` (macOS Keychain /
Windows Credential Manager), with a locked-down 0600 file fallback if no keychain
backend is available.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from .config import get_settings

SERVICE = "Tarscribe"
HF_TOKEN_KEY = "hf_token"

DEFAULT_PREFS: dict[str, Any] = {
    "language": None,  # None => auto/model default
    "asr_override": None,  # force an ASR engine, else auto by hardware
    "diarization_model": "pyannote/speaker-diarization-community-1",
    "speaker_match_threshold": 0.5,
    "llm": {"provider": "ollama", "base_url": "http://localhost:11434/v1", "model": None},
    "setup_complete": False,
}


def _prefs_path() -> Path:
    return get_settings().data_dir / "settings.json"


def _secret_fallback_path() -> Path:
    return get_settings().data_dir / ".secrets.json"


def load_prefs() -> dict[str, Any]:
    path = _prefs_path()
    if not path.exists():
        return dict(DEFAULT_PREFS)
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_PREFS)
    merged = dict(DEFAULT_PREFS)
    merged.update(data)
    return merged


def save_prefs(patch: dict[str, Any]) -> dict[str, Any]:
    prefs = load_prefs()
    for k, v in patch.items():
        if k in DEFAULT_PREFS:
            prefs[k] = v
    _prefs_path().write_text(json.dumps(prefs, indent=2))
    return prefs


# --- secrets ---------------------------------------------------------------
def _keyring():
    try:
        import keyring

        # Fail fast if only the null/fail backend is present.
        from keyring.backends.fail import Keyring as FailKeyring

        if isinstance(keyring.get_keyring(), FailKeyring):
            return None
        return keyring
    except Exception:
        return None


def get_hf_token() -> str | None:
    kr = _keyring()
    if kr is not None:
        try:
            tok = kr.get_password(SERVICE, HF_TOKEN_KEY)
            if tok:
                return tok
        except Exception:
            pass
    # Fallback file.
    path = _secret_fallback_path()
    if path.exists():
        try:
            return json.loads(path.read_text()).get(HF_TOKEN_KEY)
        except (json.JSONDecodeError, OSError):
            return None
    return None


def set_hf_token(token: str | None) -> None:
    kr = _keyring()
    if kr is not None:
        try:
            if token:
                kr.set_password(SERVICE, HF_TOKEN_KEY, token)
            else:
                kr.delete_password(SERVICE, HF_TOKEN_KEY)
            return
        except Exception:
            pass
    # Fallback: 0600 file.
    path = _secret_fallback_path()
    if token:
        path.write_text(json.dumps({HF_TOKEN_KEY: token}))
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    elif path.exists():
        path.unlink()


def has_hf_token() -> bool:
    return bool(get_hf_token())

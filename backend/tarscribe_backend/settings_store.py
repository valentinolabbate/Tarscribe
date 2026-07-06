"""User settings + secret storage.

Non-secret preferences live in ``settings.json`` in the app data dir. Secrets go
into the OS keychain via ``keyring`` (macOS Keychain / Windows Credential Manager).
The legacy plaintext fallback file is disabled unless explicitly enabled for dev.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from .config import get_settings
from .performance_profiles import DEFAULT_DIARIZATION_MODEL, DEFAULT_PROFILE

SERVICE = "Tarscribe"
HF_TOKEN_KEY = "hf_token"
LLM_API_KEY_KEY = "llm_api_key"
RAG_API_KEY_KEY = "rag_api_key"
CALDAV_PASSWORD_KEY = "caldav_password"
INSECURE_SECRET_FALLBACK_ENV = "TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK"


class SecretStorageUnavailable(RuntimeError):
    pass

DEFAULT_PREFS: dict[str, Any] = {
    "language": None,  # None => auto/model default
    "performance_profile": DEFAULT_PROFILE,
    "asr_override": None,  # force an ASR engine, else auto by hardware
    "asr_model": "",  # optional free-form model name/id for the selected ASR engine
    "recording_source": "microphone",  # future: system audio, optionally mixed with microphone
    "recording_device_id": "",  # empty => browser/system default microphone
    "diarization_model": DEFAULT_DIARIZATION_MODEL,
    "speaker_match_threshold": 0.5,
    # Known-speaker id treated as "me": action items assigned to this speaker's
    # name are the ones shown in the global Tasks area by default. 0/None = unset.
    "my_speaker_id": None,
    "llm": {"provider": "ollama", "base_url": "http://localhost:11434/v1", "model": None},
    # RAG embedding endpoint — configured independently from the chat `llm` block.
    "rag_enabled": True,
    "rag": {
        "base_url": "http://localhost:11434/v1",
        "model": "nomic-embed-text",
        "dimension": 768,
        "top_k": 6,
    },
    "setup_complete": False,
    # Live transcription feature flags (plan §10).
    "live_transcription_enabled": True,
    "live_speaker_detection_enabled": True,
    # Maximum transcript characters per LLM call before map-reduce chunking kicks in.
    "llm_chunk_size": 48000,
    # When on (and RAG is enabled), summaries are enriched with relevant passages
    # from the same topic's other transcripts, summaries and uploaded documents.
    "summary_use_topic_knowledge": True,
    # Global Markdown destination for cross-topic digests, e.g. an Obsidian vault folder.
    "digest_export_path": "",
    "dictation_shortcut": "Alt+Meta+D",
    "meeting_detection_enabled": False,
    "meeting_detection_apps": ["zoom.us", "Microsoft Teams", "Webex", "Cisco Webex Meetings"],
    "caldav": {"url": "", "username": ""},
    # Agentic RAG: when on (and RAG is enabled and the chat model supports tools),
    # the LLM may iteratively search the knowledge base via native OpenAI tool
    # calls before generating summaries, action items, chapters, dictation or
    # digests. Falls back to one-shot RAG enrichment when the model lacks tool
    # support.
    "agent_rag_enabled": False,
    "agent_rag": {
        "max_rounds": 5,
        "max_context_tokens": 12000,
        "top_k": 6,
    },
}


def _prefs_path() -> Path:
    return get_settings().data_dir / "settings.json"


def _secret_fallback_path() -> Path:
    return get_settings().data_dir / ".secrets.json"


def _insecure_fallback_enabled() -> bool:
    return os.environ.get(INSECURE_SECRET_FALLBACK_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def secret_storage_status() -> dict[str, bool]:
    keyring_available = _keyring() is not None
    fallback_enabled = _insecure_fallback_enabled()
    return {
        "available": keyring_available or fallback_enabled,
        "secure": keyring_available,
        "keyring_available": keyring_available,
        "fallback_enabled": fallback_enabled,
    }


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


def _secret_get(key: str) -> str | None:
    kr = _keyring()
    if kr is not None:
        try:
            val = kr.get_password(SERVICE, key)
            if val:
                return val
        except Exception:
            pass
    if not _insecure_fallback_enabled():
        return None
    path = _secret_fallback_path()
    if path.exists():
        try:
            return json.loads(path.read_text()).get(key)
        except (json.JSONDecodeError, OSError):
            return None
    return None


def _secret_set(key: str, value: str | None) -> None:
    kr = _keyring()
    last_error: Exception | None = None
    if kr is not None:
        try:
            if value:
                kr.set_password(SERVICE, key, value)
            else:
                if kr.get_password(SERVICE, key):
                    kr.delete_password(SERVICE, key)
            return
        except Exception as exc:
            last_error = exc
    if not _insecure_fallback_enabled():
        detail = f": {last_error}" if last_error else ""
        raise SecretStorageUnavailable(f"Kein sicherer Secret-Speicher verfügbar{detail}")
    path = _secret_fallback_path()
    data: dict[str, Any] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            data = {}
    if value:
        data[key] = value
    else:
        data.pop(key, None)
    if data:
        path.write_text(json.dumps(data))
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    elif path.exists():
        path.unlink()


def get_hf_token() -> str | None:
    return _secret_get(HF_TOKEN_KEY)


def set_hf_token(token: str | None) -> None:
    _secret_set(HF_TOKEN_KEY, token)


def has_hf_token() -> bool:
    return bool(get_hf_token())


def get_llm_api_key() -> str | None:
    return _secret_get(LLM_API_KEY_KEY)


def set_llm_api_key(key: str | None) -> None:
    _secret_set(LLM_API_KEY_KEY, key)


def has_llm_api_key() -> bool:
    return bool(get_llm_api_key())


def get_rag_api_key() -> str | None:
    return _secret_get(RAG_API_KEY_KEY)


def set_rag_api_key(key: str | None) -> None:
    _secret_set(RAG_API_KEY_KEY, key)


def has_rag_api_key() -> bool:
    return bool(get_rag_api_key())


def get_caldav_password() -> str | None:
    return _secret_get(CALDAV_PASSWORD_KEY)


def set_caldav_password(password: str | None) -> None:
    _secret_set(CALDAV_PASSWORD_KEY, password)


def has_caldav_password() -> bool:
    return bool(get_caldav_password())

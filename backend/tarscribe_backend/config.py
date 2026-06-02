"""Runtime configuration and on-disk locations for the backend."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from platformdirs import user_data_dir
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_NAME = "Tarscribe"
APP_AUTHOR = "Tarscribe"


def _default_data_dir() -> Path:
    return Path(user_data_dir(APP_NAME, APP_AUTHOR))


class Settings(BaseSettings):
    """Backend settings, overridable via TARSCRIBE_* environment variables."""

    model_config = SettingsConfigDict(env_prefix="TARSCRIBE_", extra="ignore")

    # Networking. host/port are normally injected by the Tauri shell.
    host: str = "127.0.0.1"
    port: int = 8765
    # Shared secret used to authenticate the frontend against the sidecar.
    # Empty string => auth disabled (used by tests). The sidecar entrypoint
    # generates one when launching for real (see __main__.generate_token).
    auth_token: str = ""

    # Storage
    data_dir: Path = _default_data_dir()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._ensure_dirs()

    # --- derived locations -------------------------------------------------
    @property
    def db_path(self) -> Path:
        return self.data_dir / "tarscribe.db"

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def samples_dir(self) -> Path:
        """Where speaker enrollment voice samples are stored."""
        return self.data_dir / "voice_samples"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def live_pcm_dir(self) -> Path:
        """Per-session raw PCM files for live recording."""
        return self.data_dir / "live_pcm"

    @property
    def native_recordings_dir(self) -> Path:
        """Temporary CAF files produced by the native macOS recorder."""
        return self.data_dir / "native-recordings"

    def _ensure_dirs(self) -> None:
        for d in (
            self.data_dir,
            self.audio_dir,
            self.models_dir,
            self.samples_dir,
            self.logs_dir,
            self.live_pcm_dir,
            self.native_recordings_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    # Allow an explicit data dir override useful for tests.
    override = os.environ.get("TARSCRIBE_DATA_DIR")
    if override:
        return Settings(data_dir=Path(override))
    return Settings()

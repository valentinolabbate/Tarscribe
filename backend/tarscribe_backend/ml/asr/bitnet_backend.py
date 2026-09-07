from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

from ...asr_catalog import BITNET_FILES, alignment_language
from ...config import get_settings
from .mlx_audio_backend import MlxAudioBackend


def bitnet_binary() -> Path:
    configured = os.environ.get("TARSCRIBE_BITNET_BINARY")
    if configured:
        return Path(configured).expanduser()
    bundled = Path(__file__).resolve().parents[4] / "vibeasr" / "asr_stream_server"
    if bundled.is_file():
        return bundled
    return get_settings().models_dir / "vibeasr" / "asr_stream_server"


class BitNetBackend(MlxAudioBackend):
    def __init__(self, model_id: str | None = None, hotwords: list[str] | None = None):
        super().__init__(
            "vibevoice-bitnet", model_id=model_id, hotwords=hotwords, chunk_seconds=60.0
        )

    def _ensure_model(self):
        if not bitnet_binary().is_file() or not os.access(bitnet_binary(), os.X_OK):
            raise RuntimeError(
                "BitNet-Laufzeit fehlt. Bitte scripts/setup_bitnet.py ausführen oder "
                "TARSCRIBE_BITNET_BINARY auf asr_stream_server setzen."
            )
        if self._model is None:
            from huggingface_hub import snapshot_download

            path = Path(self.model_id).expanduser()
            if not path.is_dir():
                try:
                    path = Path(snapshot_download(self.model_id, local_files_only=True))
                    if not all((path / name).is_file() for name in BITNET_FILES):
                        raise FileNotFoundError
                except OSError:
                    path = Path(snapshot_download(self.model_id, allow_patterns=list(BITNET_FILES)))
            if not all((path / name).is_file() for name in BITNET_FILES):
                raise RuntimeError(
                    "BitNet-Modell unvollständig: Beide GGUF-Dateien werden benötigt."
                )
            self._model = path
        return self._model

    def _recognize(self, path: Path, language: str | None):
        root = self._ensure_model()
        args = [
            str(bitnet_binary()),
            "--vae-model",
            str(root / BITNET_FILES[0]),
            "--lm-model",
            str(root / BITNET_FILES[1]),
            "--greedy",
            "--no-token-stream",
            "--prompt-format",
            "text",
            "--max-tokens",
            "4096",
            "-t",
            "4",
            "--context",
            f"Language: {alignment_language(language)}. " + ", ".join(self.hotwords),
        ]
        try:
            process = subprocess.run(
                args,
                input=str(path.resolve()) + "\nEXIT\n",
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                "BitNet hat das Zeitlimit für einen Audioabschnitt überschritten."
            ) from exc
        if process.returncode != 0 or "---END---" not in process.stdout:
            raise RuntimeError(f"BitNet-Inferenz fehlgeschlagen (Exit {process.returncode}).")
        output = process.stdout.split("---READY---", 1)[-1].split("---END---", 1)[0].strip()
        if "[ERROR]" in output:
            raise RuntimeError("BitNet konnte den Audioabschnitt nicht verarbeiten.")
        try:
            segments = json.loads(output)
        except json.JSONDecodeError:
            import soundfile as sf

            if output.startswith(("[", "{", "```")):
                raise RuntimeError(
                    "BitNet hat ein unvollständiges strukturiertes Ergebnis geliefert."
                )
            segments = [{"text": output, "start": 0, "end": sf.info(str(path)).duration}]
        if not isinstance(segments, list) or not all(isinstance(s, dict) for s in segments):
            raise RuntimeError("BitNet hat ein unerwartetes Transkriptformat geliefert.")
        return SimpleNamespace(text=output, segments=segments, language=language)

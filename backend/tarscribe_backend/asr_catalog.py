from __future__ import annotations

ALIGNER_MODEL = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
BITNET_FILES = ("vibeasr-vae-encoder-i8_s.gguf", "vibeasr-lm-i2_s-embed-q6_k.gguf")
EXPERIMENTAL_ASR = {
    "qwen3-mlx": {
        "model": "mlx-community/Qwen3-ASR-1.7B-8bit",
        "label": "Qwen3-ASR 1.7B",
        "files": ("config.json", "model.safetensors", "tokenizer_config.json"),
        "alignment": True,
    },
    "nemotron-mlx": {
        "model": "mlx-community/nemotron-3.5-asr-streaming-0.6b",
        "label": "Nemotron 3.5 ASR",
        "files": ("config.json", "model.safetensors", "tokenizer.model"),
        "alignment": False,
    },
    "moss-mlx": {
        "model": "OpenMOSS-Team/MOSS-Transcribe-Diarize",
        "label": "MOSS Transcribe Diarize",
        "files": ("config.json", "model-00000-of-00001.safetensors", "tokenizer.json"),
        "alignment": True,
    },
    "vibevoice-mlx": {
        "model": "microsoft/VibeVoice-ASR-Streaming-1.5B",
        "label": "VibeVoice ASR Streaming",
        "files": ("config.json", "model.safetensors.index.json", "tokenizer.json"),
        "alignment": True,
    },
    "vibevoice-bitnet": {
        "model": "microsoft/VibeVoice-ASR-BitNet",
        "label": "VibeVoice ASR BitNet",
        "files": BITNET_FILES,
        "alignment": True,
    },
}

ALIGNMENT_LANGUAGES = {
    "de": "German",
    "en": "English",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "yue": "Cantonese",
}


def alignment_language(language: str | None) -> str:
    value = (language or "").lower()
    for code, name in ALIGNMENT_LANGUAGES.items():
        if value in (code, name.lower()) or value.startswith(code + "-"):
            return name
    raise ValueError(
        "Für dieses Modell bitte eine unterstützte Transkriptionssprache in den "
        "Einstellungen wählen (z. B. Deutsch). Automatische Wortausrichtung ist hier "
        "nur für Deutsch, Englisch, Französisch, Spanisch, Italienisch, Portugiesisch, "
        "Russisch, Japanisch, Koreanisch, Chinesisch und Kantonesisch verfügbar."
    )

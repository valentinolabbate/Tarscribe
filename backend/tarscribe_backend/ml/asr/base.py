"""Common interface and data types for ASR backends.

Every backend turns an audio file into a list of word-level segments with
timestamps (mandatory for clean speaker alignment downstream).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

# Progress callback: (fraction 0..1, human message)
ProgressCb = Callable[[float, str], None]


@dataclass
class WordSeg:
    start: float
    end: float
    text: str
    confidence: float | None = None


@dataclass
class TranscriptResult:
    language: str | None
    words: list[WordSeg] = field(default_factory=list)
    model: str = ""

    @property
    def text(self) -> str:
        return "".join(w.text for w in self.words).strip()


class ASRBackend(Protocol):
    name: str

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        progress: ProgressCb | None = None,
    ) -> TranscriptResult: ...

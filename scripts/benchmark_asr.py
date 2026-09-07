from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import os
from pathlib import Path
import resource
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(
        description="Privater lokaler ASR-Vergleich ohne App-Datenbank"
    )
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--engine",
        required=True,
        choices=[
            "qwen3-mlx",
            "nemotron-mlx",
            "moss-mlx",
            "vibevoice-mlx",
            "vibevoice-bitnet",
            "parakeet-mlx",
            "mlx-whisper",
            "faster-whisper",
        ],
    )
    parser.add_argument("--language", default="de")
    parser.add_argument("--start-seconds", type=float, default=0)
    parser.add_argument("--duration-seconds", type=float)
    parser.add_argument("--keep-transcript", action="store_true")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    if output == repo or repo in output.parents:
        raise SystemExit("Private Testergebnisse dürfen nicht im Git-Projekt liegen.")
    if not args.audio.is_file():
        raise SystemExit("Audiodatei nicht gefunden.")
    if args.start_seconds < 0 or (args.duration_seconds is not None and args.duration_seconds <= 0):
        raise SystemExit("Start muss nichtnegativ und Dauer positiv sein.")
    if args.engine == "vibevoice-bitnet" and not os.environ.get("TARSCRIBE_BITNET_BINARY"):
        from tarscribe_backend.config import get_settings
        from tarscribe_backend.ml.asr.bitnet_backend import bitnet_binary

        os.environ["TARSCRIBE_BITNET_BINARY"] = str(bitnet_binary())
        get_settings.cache_clear()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ["TARSCRIBE_DATA_DIR"] = str(output / "isolated-data")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import soundfile as sf
    from tarscribe_backend.ml.asr.factory import build_backend

    info = sf.info(str(args.audio))
    duration = min(args.duration_seconds or info.duration, info.duration - args.start_seconds)
    if duration <= 0:
        raise SystemExit("Der Ausschnitt liegt außerhalb der Audiodatei.")
    last = 0.0

    def progress(fraction, _message):
        nonlocal last
        if time.monotonic() - last > 30:
            print(
                json.dumps({"engine": args.engine, "progress": round(fraction, 3)}),
                flush=True,
            )
            last = time.monotonic()

    started = time.monotonic()
    backend = build_backend(selection={"engine": args.engine})
    with tempfile.TemporaryDirectory(prefix="tarscribe-benchmark-") as temp:
        audio_path = args.audio
        if args.start_seconds or args.duration_seconds:
            audio_path = Path(temp) / "sample.wav"
            with sf.SoundFile(str(args.audio)) as source:
                source.seek(round(args.start_seconds * info.samplerate))
                samples = source.read(round(duration * info.samplerate), dtype="float32")
                sf.write(str(audio_path), samples, info.samplerate)
        with (output / (args.engine + ".runtime.log")).open("w") as log:
            with contextlib.redirect_stderr(log):
                result = backend.transcribe(audio_path, language=args.language, progress=progress)
    elapsed = time.monotonic() - started
    invalid = sum(not (0 <= word.start <= word.end <= duration + 0.01) for word in result.words)
    metrics = {
        "engine": args.engine,
        "model": result.model,
        "audio_seconds": duration,
        "source_offset_seconds": args.start_seconds,
        "elapsed_seconds": elapsed,
        "rtf": elapsed / duration,
        "peak_rss_gb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**3,
        "word_or_token_count": len(result.words),
        "speaker_segments": len(result.speakers),
        "invalid_timestamps": invalid,
        "language": result.language,
    }
    (output / (args.engine + ".metrics.json")).write_text(json.dumps(metrics, indent=2))
    if args.keep_transcript:
        (output / (args.engine + ".transcript.json")).write_text(
            json.dumps(dataclasses.asdict(result), ensure_ascii=False)
        )
    print(json.dumps(metrics), flush=True)
    if invalid or not result.words:
        raise SystemExit("Transkript leer oder ungültige Zeitmarken.")


if __name__ == "__main__":
    main()

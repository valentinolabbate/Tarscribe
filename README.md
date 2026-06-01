# Tarscribe

Lokale Transkriptions- & Speaker-Diarisierungs-App für **Windows** und **macOS Silicon**.
Themenbereiche anlegen, Aufnahmen hochladen/erstellen, vollständig **offline** transkribieren und
Sprecher trennen — mit nachträglich feinjustierbarer Diarisierung, Stimmproben-Identifikation und
lokaler LLM-Zusammenfassung (Ollama / LM Studio).

## Architektur

```
desktop/        Tauri v2 Shell (Rust) + React/TS/Vite Frontend
  src/          UI (Themenbereiche, Aufnahmen, später Transcript-Editor & Tuning)
  src-tauri/    Rust: startet das Python-Backend als Sidecar, native Integration
backend/        Python FastAPI Sidecar (ASR, Diarisierung, DB, Jobs)
  tarscribe_backend/
```

Die Rust-Shell wählt beim Start einen freien Loopback-Port + Token, startet das Backend
(`python -m tarscribe_backend`) und reicht die Verbindungsdaten via `backend_config`-Command an das
Frontend. Daten liegen im OS-App-Data-Verzeichnis (SQLite + Audio).

## Entwicklung

Voraussetzungen: Node, Rust (`rustup`), Python 3.11/3.12, [`uv`](https://docs.astral.sh/uv/), `ffmpeg`.

```bash
# Backend-Env
cd backend && uv venv --python 3.12 .venv && uv pip install -e ".[dev]"

# Frontend-Deps
cd ../desktop && npm install

# Komplette App (startet Backend-Sidecar automatisch)
npm run tauri dev
```

### Schnelles UI-Testing im Browser (ohne Rust-Build)

```bash
# 1) Backend ohne Auth starten
cd backend && TARSCRIBE_AUTH_TOKEN="" .venv/bin/python -m uvicorn tarscribe_backend.main:app --port 8765
# 2) Frontend
cd desktop && npm run dev   # http://localhost:1420 (Fallback auf 127.0.0.1:8765)
```

## Tests

```bash
cd backend && .venv/bin/python -m pytest
```

## Status

Aktueller Stand: **v0.1.2** ist als macOS-Release veröffentlicht.

Umgesetzt sind Themenbereiche, Uploads und In-App-Aufnahmen, ffmpeg-Normalisierung,
lokale ASR-Backends, Speaker-Diarisierung mit Tuning, Sprecher-Bibliothek,
Voiceprint-Zuordnung, LLM-Zusammenfassungen, Export, Settings/Keychain sowie
macOS-Packaging mit Auto-Updates über GitHub Releases.

Hinweis für macOS: Die App findet Homebrew-Installationen von `ffmpeg`/`ffprobe`
auch aus der installierten GUI-App heraus (`/opt/homebrew/bin`, `/usr/local/bin`
u. a.). Optional können die Pfade über `TARSCRIBE_FFMPEG_PATH` und
`TARSCRIBE_FFPROBE_PATH` explizit gesetzt werden.

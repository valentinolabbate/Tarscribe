# Tarscribe

Lokale Transkriptions- & Speaker-Diarisierungs-App für **macOS (Apple Silicon)**.  
Themenbereiche anlegen, Aufnahmen hochladen oder direkt aufnehmen, vollständig **offline**
transkribieren und Sprecher trennen — mit feinjustierbarer Diarisierung, Stimmproben-Identifikation
und lokaler LLM-Zusammenfassung (Ollama / LM Studio).

## Installation (macOS)

1. **DMG herunterladen** von [Releases](https://github.com/valentinolabbate/Tarscribe/releases/latest)
2. **DMG öffnen** — du siehst `Tarscribe.app`, einen `Applications`-Ordner und `Tarscribe installieren.command`
3. **Doppelklick auf `Tarscribe installieren.command`**
   - macOS fragt: *„Aus dem Internet heruntergeladen — trotzdem öffnen?"* → **Öffnen**
   - Falls ein zweiter Dialog erscheint (für das Skript selbst): ebenfalls in **Systemeinstellungen → Datenschutz & Sicherheit → Trotzdem öffnen** freigeben
   - Terminal öffnet sich, kopiert die App nach `/Applications` und entfernt den Quarantäne-Flag
4. Tarscribe startet automatisch und ist danach in **Finder, Launchpad und Spotlight** sichtbar

> **Warum das Skript?** macOS 26 blockiert nicht-notarisierte Apps in Finder und Launchpad,
> auch nach manueller Security-Freigabe. Das Skript entfernt den `com.apple.quarantine`-Flag,
> der dieses Verhalten auslöst.

## Architektur

```
desktop/        Tauri v2 Shell (Rust) + React/TS/Vite Frontend
  src/          UI (Themenbereiche, Aufnahmen, Transcript-Editor, Tuning)
  src-tauri/    Rust: startet das Python-Backend als Sidecar, native Integration
backend/        Python FastAPI Sidecar (ASR, Diarisierung, DB, Jobs)
  tarscribe_backend/
```

Die Rust-Shell wählt beim Start einen freien Loopback-Port + Token, startet das Backend
(`python -m tarscribe_backend`) und reicht die Verbindungsdaten via `backend_config`-Command
an das Frontend. Daten liegen im macOS App-Data-Verzeichnis (SQLite + Audio).

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

## Release bauen

```bash
cd desktop && npx tauri build   # erstellt .app in src-tauri/target/release/bundle/macos/
cd .. && ./scripts/build-dmg.sh # verpackt .app + Installer-Skript in eine DMG
```

## Tests

```bash
cd backend && .venv/bin/python -m pytest
```

## Hinweise

- **ffmpeg**: Die App findet Homebrew-Installationen automatisch (`/opt/homebrew/bin`, `/usr/local/bin`).
  Optional via `TARSCRIBE_FFMPEG_PATH` und `TARSCRIBE_FFPROBE_PATH` überschreibbar.
- **Aktueller Stand**: v0.1.7 — macOS Apple Silicon

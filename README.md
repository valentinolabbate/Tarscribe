# Tarscribe

Tarscribe ist eine lokale macOS-App für Aufnahmen, Transkription, Sprechererkennung,
Zusammenfassungen und Wissenssuche über Audioinhalte. Die App läuft auf Apple Silicon
und verarbeitet deine Daten lokal auf dem Mac.

**Aktueller Stand:** v0.6.8 · macOS Apple Silicon · Tauri + React + FastAPI

## Was Tarscribe kann

- Audio oder Video importieren und direkt im Themenbereich organisieren
- Mikrofon, System-Audio oder beides aufnehmen
- Aufnahmen lokal transkribieren – wahlweise live mit, während du sprichst
- Sprecher erkennen, benennen, zusammenführen und als bekannte Stimmen speichern
- KI-Zusammenfassungen über frei wählbare Vorlagen mit lokalen LLM-Servern wie Ollama oder LM Studio erstellen
- Aufgaben und Entscheidungen automatisch aus Gesprächen extrahieren und gebündelt im Aufgaben-Bereich verwalten
- Aufnahmen automatisch in Kapitel gliedern und Sprecheranteile auswerten
- Per Diktat-Inbox einen Gedanken einsprechen – über einen globalen Hotkey, auch wenn die App im Hintergrund läuft
- Transkripte und Zusammenfassungen hybrid durchsuchen (Volltext + semantisch)
- Einzelne Aufnahmen oder die gesamte Bibliothek per Wissens-Chat befragen
- TXT, SRT, VTT, JSON und WAV exportieren

## Installation auf macOS

1. Lade die aktuelle DMG aus den [GitHub Releases](https://github.com/valentinolabbate/Tarscribe/releases/latest).
2. Öffne die DMG.
3. Rechtsklick auf `Tarscribe installieren.command` -> **Öffnen**.
4. Falls macOS blockiert: **Systemeinstellungen -> Datenschutz & Sicherheit -> Trotzdem öffnen** wählen und das Installationsskript erneut öffnen.

Das Skript kopiert Tarscribe nach `/Applications`, entfernt den Quarantäne-Flag und startet
die App. Danach ist Tarscribe über Finder, Launchpad und Spotlight verfügbar.

> Tarscribe ist derzeit ad-hoc signiert und nicht Apple-notarisiert. Die einmalige
> Rechtsklick-Freigabe ist deshalb normal. Nach der Installation laufen spätere App-Updates
> über den integrierten Updater.

## Erster Start

Beim ersten Start prüft Tarscribe die lokale Umgebung und richtet die benötigten Komponenten ein.
Modell-Downloads benötigen einmalig Internet. Danach funktionieren Transkription, Suche und
lokale Verarbeitung offline. Zusammenfassungen und Chat benötigen zusätzlich einen lokalen
LLM-Server, zum Beispiel Ollama oder LM Studio.

Für Sprechererkennung mit bestimmten Modellen kann ein Hugging Face Token nötig sein. Die App
fragt diesen bei Bedarf im Einrichtungsassistenten ab.

## Arbeitsweise in der App

1. Lege einen Themenbereich an, zum Beispiel `Interviews`, `Meetings` oder `Vorlesungen`.
2. Nimm Audio auf oder importiere eine vorhandene Datei.
3. Öffne die Aufnahme und transkribiere sie.
4. Nutze die Detailseite in getrennten Bereichen:
   - **Transkript** für Text, Zeitmarken, Kapitel und Wiedergabe
   - **Zusammenfassung** für KI-Auswertungen über frei wählbare Vorlagen
   - **Fragen** für Suche und Chat innerhalb der Aufnahme
   - **Sprecher** für Namen, Stimmprofile, Sprecherstatistik und Diarisierungs-Tuning
5. Behalte Aufgaben und Entscheidungen aus allen Aufnahmen im globalen **Aufgaben**-Bereich im Blick.
6. Sprich spontane Gedanken über die **Diktat-Inbox** ein – per globalem Hotkey landen sie in der Inbox, werden transkribiert und auf Aufgaben geprüft.
7. Exportiere Text, Untertitel, JSON oder Audio bei Bedarf in deinen Zielordner.

## Entwicklung

Voraussetzungen:

- macOS auf Apple Silicon
- Node.js
- Rust mit `rustup`
- Python 3.11 oder 3.12
- [`uv`](https://docs.astral.sh/uv/)
- `ffmpeg`

```bash
# Backend-Umgebung
cd backend
uv venv --python 3.12 .venv
uv pip install -e ".[dev]"

# Frontend-Abhängigkeiten
cd ../desktop
npm install

# Komplette Desktop-App starten
npm run tauri dev
```

### UI schnell im Browser testen

```bash
# Terminal 1: Backend ohne Auth
cd backend
TARSCRIBE_AUTH_TOKEN="" .venv/bin/python -m uvicorn tarscribe_backend.main:app --port 8765

# Terminal 2: Frontend
cd desktop
npm run dev
```

Das Vite-Frontend läuft dann unter `http://localhost:1420` und verbindet sich mit dem Backend
auf `127.0.0.1:8765`.

## Architektur

```text
desktop/        Tauri v2 Desktop-Shell mit React, TypeScript und Vite
  src/          UI, Aufnahmefluss, Suche, Chat, Einstellungen
  src-tauri/    Rust-Shell, Sidecar-Start, native macOS-Integration

backend/        FastAPI-Sidecar für ASR, Diarisierung, Jobs, SQLite und RAG
  tarscribe_backend/
```

Die Tauri-Shell startet das Python-Backend als lokalen Sidecar-Prozess. Das Frontend bekommt
Port und Auth-Token über einen Tauri-Command. Nutzerdaten liegen im macOS-App-Data-Verzeichnis
als SQLite-Datenbank plus Audiodateien.

## Tests und Build

```bash
# Frontend
cd desktop
npm run build

# Backend
cd backend
.venv/bin/python -m pytest

# Release-Build
cd desktop
npm run tauri build
cd ..
./scripts/build-dmg.sh
```

Weitere Details zu Releases und Auto-Updates stehen in [RELEASING.md](RELEASING.md).

## Hinweise

- `ffmpeg` wird für Import, Normalisierung und Export benötigt. Homebrew-Installationen unter
  `/opt/homebrew/bin` oder `/usr/local/bin` werden automatisch erkannt.
- Ohne Apple Developer ID kann die App nicht vollständig notarisiert werden. Für interne Tests
  und private Weitergabe ist der Installer-Workflow in der DMG der vorgesehene Weg.
- Tarscribe ist auf lokale Verarbeitung ausgelegt. Externe LLM- oder Embedding-Server werden nur
  genutzt, wenn du sie in den Einstellungen konfigurierst.

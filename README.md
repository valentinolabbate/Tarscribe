# Tarscribe

Tarscribe ist eine macOS-App für Aufnahmen, Transkription, Sprechererkennung,
Zusammenfassungen und Wissenssuche über Audioinhalte. Die Audioverarbeitung läuft auf
Apple Silicon; optionale Chat- und Embedding-Funktionen nutzt du über frei
konfigurierbare Anbieter oder Endpoints.

**Aktueller Stand:** v0.13.1 · macOS Apple Silicon · Tauri + React + FastAPI

## Was Tarscribe kann

**Aufnehmen & Importieren**
- Mikrofon, System-Audio oder beides aufnehmen
- Audio oder Video importieren und direkt im Themenbereich organisieren
- Spontane Gedanken über die **Diktat-Inbox** einsprechen – per globalem Hotkey, auch wenn die App im Hintergrund läuft
- Optionale Meeting-Erkennung bietet eine Aufnahme an, sobald eine Konferenz-App **aktiv das Mikrofon nutzt** (nicht schon, wenn sie nur im Hintergrund läuft)

**Transkribieren & Sprecher**
- Aufnahmen lokal transkribieren – wahlweise live, während du sprichst
- Sprecher erkennen, benennen, zusammenführen und als bekannte Stimmen speichern
- Sprecheranteile auswerten und die Diarisierung feinjustieren
- Aufnahmen automatisch in Kapitel gliedern

**Auswerten**
- KI-Zusammenfassungen über frei wählbare Vorlagen mit einem konfigurierbaren Chat-Modell
- Zusammenfassungen beziehen bei Bedarf automatisch relevantes Wissen aus demselben Themenbereich ein (andere Transkripte, Zusammenfassungen und hochgeladene Dateien) – sichtbar belegt, welche Quellen eingeflossen sind
- Optional kann das Chat-Modell den Themenbereich **aktiv und iterativ** durchsuchen („Agentic RAG"): Es formuliert eigene Suchanfragen an den Wissensindex, wertet die Treffer aus und recherchiert so lange weiter, bis es genug Kontext gesammelt hat. Gilt für Zusammenfassungen, Aufgaben, Kapitel, Diktat und Digest. Aktivierbar in den Einstellungen (Standard: aus); Modelle ohne Tool-Unterstützung erhalten automatisch den bisherigen einmaligen Kontext. Während der Recherche zeigt die App live die gestellten Suchanfragen und Treffer an.
- Aufgaben und Entscheidungen automatisch aus Gesprächen extrahieren; der **Aufgaben**-Bereich zeigt standardmäßig nur deine eigenen (lege in den Einstellungen fest, wer „Ich" ist) und lässt andere gezielt übernehmen
- Wochen-Digest über die letzten Tage erzeugen und semantisch erkannte Themen-Threads über mehrere Aufnahmen hinweg verfolgen
- **People Memory** bündelt pro bekanntem Sprecher gemeinsame Gespräche, offene Zusagen, Entscheidungen und Themen-Threads mit Links zurück zu den belegenden Aufnahmen

**Suchen & Fragen**
- Transkripte, Zusammenfassungen und Dokumente hybrid durchsuchen (Volltext + semantisch)
- Einzelne Aufnahmen oder die gesamte Bibliothek per Wissens-Chat befragen – mit klickbaren Quellenangaben; der Chat-Verlauf bleibt erhalten
- Referenz-Dokumente (PDF, DOCX, TXT, MD) zu einem Themenbereich oder einer Aufnahme hochladen und automatisch in Suche und Chat einbeziehen

**Exportieren & Automatisieren**
- TXT, SRT, VTT, JSON und WAV exportieren oder eine Markdown-Notiz in einen Ordner (z. B. Obsidian) schreiben
- Über den **mitgelieferten MCP-Server** können Agenten Tarscribe steuern (siehe [Agenten (MCP)](#agenten-mcp))

## Installation auf macOS

Tarscribe ist ad-hoc signiert und **nicht Apple-notarisiert**. Beim ersten Mal führt macOS
(Sequoia) deshalb durch eine mehrstufige Gatekeeper-Freigabe. Das ist normal und nur einmalig
nötig – spätere Updates laufen über den integrierten Updater ohne diese Schritte.

1. Lade die aktuelle DMG aus den [GitHub Releases](https://github.com/valentinolabbate/Tarscribe/releases/latest) und öffne sie.
2. Rechtsklick auf **`Tarscribe installieren.command` → Öffnen**. macOS **blockiert** das Skript.
3. **Systemeinstellungen → Datenschutz & Sicherheit** öffnen und beim Hinweis auf das blockierte Skript **„Trotzdem öffnen"** wählen.
4. Das Skript **erneut öffnen**. Es kopiert Tarscribe nach **/Programme** und startet die App – aber macOS **blockiert jetzt Tarscribe selbst**, weil das Programm noch nicht freigegeben ist.
5. Wieder in **Datenschutz & Sicherheit** beim Hinweis auf **Tarscribe** **„Trotzdem öffnen"** wählen.
6. Das Skript **noch einmal öffnen** und in den Einstellungen erneut freigeben.
7. Zuletzt Tarscribe kurz **mit dem Admin-Passwort** bestätigen.

Danach ist Tarscribe installiert und über Finder, Launchpad und Spotlight verfügbar. Das Skript
entfernt die Quarantäne-Flags, damit die App auf macOS 26+ nicht aus Finder/Launchpad verschwindet.

> **Tipp:** Wird bereits das **DMG** als „beschädigt" gemeldet, vor dem Öffnen einmal
> `xattr -cr ~/Downloads/Tarscribe_*.dmg` ausführen.

### Updates

Nach der Erstinstallation prüft Tarscribe beim Start auf neue Releases und installiert sie über
den **integrierten Updater** – **ohne** erneute Gatekeeper-Freigabe. Die Gatekeeper-Schritte oben
fallen also wirklich nur beim ersten Mal an.

## Erster Start

Beim ersten Start prüft Tarscribe die lokale Umgebung und richtet die benötigten Komponenten ein.
Modell-Downloads benötigen einmalig Internet. Danach funktionieren Transkription und
grundlegende Verarbeitung offline. Zusammenfassungen und Chat benötigen ein konfiguriertes
Chat-Modell; der Wissens-Chat/RAG nutzt einen separat konfigurierbaren Embedding-Endpoint.

Für Sprechererkennung mit bestimmten Modellen kann ein Hugging Face Token nötig sein. Die App
fragt diesen bei Bedarf im Einrichtungsassistenten ab.

## Arbeitsweise in der App

1. Lege einen Themenbereich an, zum Beispiel `Interviews`, `Meetings` oder `Vorlesungen`.
2. Nimm Audio auf oder importiere eine vorhandene Datei.
3. Öffne die Aufnahme und transkribiere sie.
4. Nutze die Detailseite in getrennten Bereichen:
   - **Transkript** für Text, Zeitmarken, Kapitel und Wiedergabe
   - **Zusammenfassung** für KI-Auswertungen über frei wählbare Vorlagen – inklusive der einbezogenen Themenbereich-Quellen
   - **Fragen** für Suche und Chat innerhalb der Aufnahme sowie das Hochladen von Referenz-Dokumenten
   - **Sprecher** für Namen, Stimmprofile, Sprecherstatistik und Diarisierungs-Tuning
5. Behalte Aufgaben und Entscheidungen aus allen Aufnahmen im globalen **Aufgaben**-Bereich im Blick.
6. Nutze die **Startseite** für globale Suche, den Wissens-Chat, den Wochen-Digest und Themen-Threads.
7. Sprich spontane Gedanken über die **Diktat-Inbox** ein – per globalem Hotkey landen sie in der Inbox, werden transkribiert und auf Aufgaben geprüft.
8. Exportiere Text, Untertitel, JSON oder Audio bei Bedarf in deinen Zielordner.

## Agenten (MCP)

Tarscribe bringt einen **Model-Context-Protocol-Server** mit, über den Agenten (z. B. Claude
Desktop/Code, OpenCode, Codex) die App fernsteuern können, während sie läuft. Die Einrichtung
erfolgt in **Einstellungen → Agenten (MCP)** (Ein-Klick-Registrierung für bekannte Hosts).

Verfügbare Werkzeuge u. a.:

- Themenbereiche und Aufnahmen auflisten/anlegen, Audiodateien hochladen
- Transkription, Diarisierung, Kapitel-Erkennung und Sprecher-Abgleich starten
- `process_recording_pipeline`: kompletter Durchlauf (Upload → Transkript → Kapitel → Diarisierung → Sprecher) in einem Schritt
- Transkripte, Diarisierung und Kapitel abfragen
- **Zusammenfassung erstellen** (`create_summary`, optional mit bestimmter Vorlage per id oder Name) und **exportieren** (`export_summary`)

Der MCP-Server verbindet sich automatisch mit der laufenden Tarscribe-App – sie muss dafür
geöffnet sein.

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

> **Hinweis:** CORS ist auf Tauri- und Vite-Dev-Origins beschränkt. Für andere Origins
> (z. B. Remote-Development) `TARSCRIBE_ALLOWED_ORIGINS` setzen (Komma-getrennt).

Secrets wie Hugging Face Token, CalDAV-Passwort und LLM/RAG-API-Keys werden über
den OS-Secret-Store gespeichert. Ohne verfügbaren Keyring werden neue Secrets nicht
gespeichert; der alte Klartext-Fallback kann nur für lokale Entwicklung oder Tests
mit `TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK=1` aktiviert werden.

Security-relevante Aktionen werden getrennt von Uvicorn als rotierendes JSONL-Audit-Log
unter `<App-Data>/logs/audit.log` gespeichert. Pfad, maximale Dateigröße und Anzahl der
Backups lassen sich über `TARSCRIBE_AUDIT_LOG_PATH`, `TARSCRIBE_AUDIT_LOG_MAX_BYTES`
und `TARSCRIBE_AUDIT_LOG_BACKUP_COUNT` überschreiben. Secrets werden nicht protokolliert.

## Architektur

```text
desktop/        Tauri v2 Desktop-Shell mit React, TypeScript und Vite
  src/          UI, Aufnahmefluss, Suche, Chat, Einstellungen
  src-tauri/    Rust-Shell, Sidecar-Start, native macOS-Integration (System-Audio, Mikrofon-Status)

backend/        FastAPI-Sidecar für ASR, Diarisierung, Jobs, SQLite und RAG
  tarscribe_backend/
    routers/    HTTP-Endpunkte (Aufnahmen, LLM, RAG, Dokumente, Insights, Einstellungen …)
    mcp_server/ Mitgelieferter MCP-Server, der die laufende App fernsteuert
```

Die Tauri-Shell startet das Python-Backend als lokalen Sidecar-Prozess. Das Frontend bekommt
nur die Backend-Basisadresse; HTTP-Requests und WebSocket-Events laufen in der Desktop-App über
einen Rust-Proxy, der das interne Auth-Token nicht an den Browser-Kontext weitergibt.
Nutzerdaten liegen im macOS-App-Data-Verzeichnis als SQLite-Datenbank plus Audiodateien. Der
RAG-Index nutzt `sqlite-vec` (semantisch) und FTS5 (Volltext).

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

Weitere Details zu Releases und Auto-Updates stehen in [RELEASING.md](RELEASING.md), zur privaten
Weitergabe ohne Apple Developer ID in [SHARING.md](SHARING.md).

Dependency-Updates werden monatlich per Dependabot für npm, uv, Cargo und GitHub Actions
vorgeschlagen. Patch-/Minor-Updates sind gruppiert; Major-Updates bleiben im manuellen
Security-Review gemäß `.github/DEPENDENCY_REVIEW.md`.

## Hinweise

- `ffmpeg` wird für Import, Normalisierung und Export benötigt. Homebrew-Installationen unter
  `/opt/homebrew/bin` oder `/usr/local/bin` werden automatisch erkannt.
- Ohne Apple Developer ID kann die App nicht vollständig notarisiert werden. Für interne Tests
  und private Weitergabe ist der Installer-Workflow in der DMG der vorgesehene Weg.
- Tarscribe verarbeitet Audio und Transkription auf dem Mac. Chat- und Embedding-Endpoints
  werden nur genutzt, wenn du sie in den Einstellungen konfigurierst.
```

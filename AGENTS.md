# AGENTS.md

Konventionen und Richtlinien für Agenten, die an Tarscribe arbeiten.

## Projekt-Überblick

Tarscribe ist eine macOS-Desktop-App (Tauri v2 + React + FastAPI) für Audio-Aufnahme,
Transkription, Diarisierung, Zusammenfassungen und Wissenssuche.

- **`desktop/`** — Tauri v2 Shell: React/TypeScript Frontend (`src/`), Rust Shell (`src-tauri/`)
- **`backend/`** — Python FastAPI Sidecar: ASR, Diarisierung, Jobs, SQLite, RAG
- **Datenbank** — SQLite/SQLModel, `sqlite-vec` für semantische Suche, FTS5 für Volltext

## Build- & Test-Befehle

### Backend

```bash
cd backend
.venv/bin/python -m pytest          # Tests
.venv/bin/python -m ruff check .    # Lint
```

### Frontend

```bash
cd desktop
npm run build    # tsc --noEmit + vite build (Type-Check + Build)
npm test         # Vitest-Tests
npm run dev      # Vite Dev-Server (Browser-Modus, Port 1420)
npm run tauri dev # Komplette Desktop-App
```

### Nach jeder Änderung

1. Backend-Tests: `cd backend && .venv/bin/python -m pytest`
2. Backend-Lint: `cd backend && .venv/bin/python -m ruff check .`
3. Frontend-Tests: `cd desktop && npm test`
4. Frontend-Typecheck: `cd desktop && npm run build`

## Sicherheits-Konventionen

### CORS

CORS ist auf Tauri-Origins beschränkt (`backend/tarscribe_backend/main.py`).

- Default-Origins: `tauri://localhost`, `https://tauri.localhost`, `http://localhost:5173`, `http://localhost:1420`
- Override via `TARSCRIBE_ALLOWED_ORIGINS` (Komma-getrennt, z. B. `"http://custom.local:3000"`)
- `allow_credentials=True` ist aktiv — nur mit eingeschränkten Origins sicher
- Erlaubte Header: `Authorization`, `Content-Type`, `X-Tarscribe-Token`, `X-Sequence-Number`, `X-Sample-Rate`, `X-Channels`
- Neue Endpunkte brauchen keine CORS-Änderungen; neue Custom-Header müssen in `_ALLOWED_HEADERS` aufgenommen werden

### Auth

- Shared Secret via `X-Tarscribe-Token` Header; alternativ Cookie `tarscribe_token` oder `Sec-WebSocket-Protocol`-Token für kompatible Transportpfade
- REST-API-Router werden zentral in `backend/tarscribe_backend/main.py` mit `Depends(require_token)` eingehängt; Fachrouter sollen keine eigene `require_token`-Dependency setzen
- WebSocket `/ws` nutzt backendseitig `Sec-WebSocket-Protocol`: `tarscribe` + `tarscribe-auth-<token>`; in der Tauri-App läuft die Verbindung über den Rust-Forwarder, Query-Parameter-Token werden nicht akzeptiert
- `TARSCRIBE_AUTH_TOKEN=""` deaktiviert Auth (nur für Tests)
- Tauri-Shell generiert Token beim Sidecar-Start
- Neue API-Routen sind automatisch geschützt, wenn sie in einem der zentral eingehängten Router liegen; neue öffentliche Routen müssen explizit in `main.py` begründet werden

### Secrets

- HF-Token, CalDAV-Passwort und LLM/RAG-API-Keys werden über `keyring` im OS-Secret-Store gespeichert
- API-Responses liefern nur Status-Flags wie `*_set`, niemals Secret-Werte
- Der alte Klartext-Fallback `.secrets.json` ist standardmäßig deaktiviert
- `TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK=1` darf nur für lokale Entwicklung oder Tests verwendet werden
- Wenn kein sicherer Secret-Store verfügbar ist, antworten Secret-Schreibendpunkte mit HTTP 503

### Uploads und Pfade

- Upload-Endungen werden zentral in `backend/tarscribe_backend/upload_security.py` validiert
- Recording-Uploads akzeptieren nur Audio-Suffixe; lokale Native-Capture-Imports erlauben zusätzlich `.caf`
- Dokumente werden unter `documents/<id><suffix>` gespeichert; Downloads dürfen `Document.file_path` nicht direkt streamen
- Lokale Importpfade müssen absolut sein und innerhalb des erlaubten Ordners liegen
- `send-to-folder` schreibt nur in einen absoluten, existierenden Export-Ordner

### Audit-Log

- Security-relevante Ereignisse werden als JSONL separat unter `logs/audit.log` gespeichert
- Auth-Fehler, Uploads, Downloads, Löschungen, Exporte und MCP-Registrierungen werden erfasst
- Token-, Passwort-, Secret-, Cookie- und API-Key-Felder werden defensiv redigiert
- Rotation ist über `TARSCRIBE_AUDIT_LOG_MAX_BYTES` und `TARSCRIBE_AUDIT_LOG_BACKUP_COUNT` konfigurierbar
- `TARSCRIBE_AUDIT_LOG_PATH` überschreibt den Standardpfad

### CSP

CSP ist in `desktop/src-tauri/tauri.conf.json` unter `app.security.csp` konfiguriert.

Aktive Policy:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws://localhost:*;
img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'
```

- `script-src 'self'`: keine Inline-Scripts, kein `eval()` (Tauri injiziert Nonces für eigene IPC-Scripts)
- `style-src 'unsafe-inline'`: nötig für React-Inline-Styles und Vite-injizierte Styles
- `connect-src http://127.0.0.1:* ws://127.0.0.1:*`: Backend HTTP + WebSocket; `ws://localhost:*` für Vite-HMR im Dev-Modus
- `worker-src 'self'`: AudioWorklet wird als statische Datei aus `desktop/public/audioWorklet.js` geladen; Blob-Worker sind nicht erlaubt
- `object-src 'none'`: keine Plugins/Flash
- Externe LLM/RAG-APIs laufen über das Backend, nicht direkt vom Frontend → nicht in `connect-src` nötig
- Neue externe Verbindungen vom Frontend aus müssen in `connect-src` aufgenommen werden

## Umgebungsvariablen

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `TARSCRIBE_AUTH_TOKEN` | `""` | Shared Secret für API-Auth (leer = deaktiviert) |
| `TARSCRIBE_DATA_DIR` | Platform-Data-Dir | Verzeichnis für SQLite-DB und Audiodateien |
| `TARSCRIBE_ALLOWED_ORIGINS` | (siehe oben) | Komma-getrennte Liste erlaubter CORS-Origins |
| `TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK` | unset | Aktiviert den Klartext-Fallback `.secrets.json` nur für Entwicklung/Tests |
| `TARSCRIBE_AUDIT_LOG_PATH` | `<data-dir>/logs/audit.log` | Optionaler Pfad für das separate Audit-Log |
| `TARSCRIBE_AUDIT_LOG_MAX_BYTES` | `5000000` | Maximale Größe einer Audit-Log-Datei vor Rotation |
| `TARSCRIBE_AUDIT_LOG_BACKUP_COUNT` | `5` | Anzahl rotierter Audit-Log-Dateien |
| `TARSCRIBE_HOST` | `127.0.0.1` | Backend-Host |
| `TARSCRIBE_PORT` | `8765` | Backend-Port |

## Code-Konventionen

- **Python**: `ruff` für Lint, Zeilenlänge 100, Target Python 3.11+
- **TypeScript**: `tsc` als Typecheck, `strict`-Modus ist aktiv
- **Keine Kommentare** im Code, außer ausdrücklich gewünscht
- **Keine Secrets** in Logs, Responses oder Commits
- Tests verwenden `tempfile.mkdtemp` + `TARSCRIBE_DATA_DIR` für Isolation
- Module werden in Tests per `importlib.reload` neu geladen, wenn Env-Variablen geändert werden

## Dependency-Updates

- `.github/dependabot.yml` erstellt monatlich gruppierte Patch-/Minor-PRs für npm, uv, Cargo und GitHub Actions
- Major-Updates werden nicht automatisch geöffnet und müssen manuell geprüft werden
- `.github/workflows/dependency-security-review.yml` legt monatlich ein Review-Issue anhand von `.github/DEPENDENCY_REVIEW.md` an
- Nach Dependency-Änderungen müssen Backend-Tests/Ruff, Frontend-Tests/Build und `cargo check` grün sein

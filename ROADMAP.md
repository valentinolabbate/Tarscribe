# Tarscribe Security & Refactoring Roadmap

> Abgeleitet aus dem Code-Review vom 24.06.2026.
> Stand der analysierten Komponenten: Tauri v2 Rust-Shell, Python FastAPI-Backend, React/Vite-Frontend, SQLite/SQLModel-Datenbank, Testsuite.

---

## 0. Grundlagen und Voraussetzungen

### 0.1 Ziele dieses Plans

1. **Vertrauenswürdigkeit der lokalen API wiederherstellen**
   Kein unautorisierter Prozess oder Browser-Tab darf auf das Backend zugreifen oder Ressourcen verbrauchen.

2. **Secrets schützen**
   HF-Token, CalDAV-Passwort, LLM/RAG-API-Keys und das App-interne Auth-Token dürfen nicht im Frontend, in Logs oder im Klartext auf der Platte landen.

3. **Stabilität erhöhen**
   Endlosschleifen, Race-Conditions und manuelle Cascades eliminieren.

4. **Wartbarkeit verbessern**
   Monolithen im Frontend und Backend aufteilen, duplizierte Logik zentralisieren.

5. **Testabdeckung für Security erhöhen**
   Jeder kritische Fix wird durch einen Regressionstest abgedeckt.

### 0.2 Ausgangslage (zusammengefasst aus dem Review)

- **Backend**: FastAPI auf `127.0.0.1`, CORS auf Tauri-/Dev-Origins beschränkt, Auth via einzigem Shared Secret (`X-Tarscribe-Token`).
- **Frontend**: React/Vite/Tauri, erhält in der Desktop-App kein Backend-Token mehr und nutzt Rust-Proxys für Backend-HTTP und WebSocket-Events.
- **Shell**: Tauri v2, strikte CSP aktiv, Sidecar startet Python mit random Port/Token.
- **Datenbank**: SQLite/SQLModel, viele manuelle Löschoperationen statt DB-Cascades.
- **Tests**: Gute Funktionsabdeckung plus Security-Regressionstests für Auth, CORS, WebSocket, Secrets, Uploads und Pfadgrenzen.

### 0.3 Konventionen in diesem Dokument

- 🔴 **Kritisch**: Muss vor dem nächsten Release erledigt sein.
- 🟠 **Hoch**: Sollte im nächsten Sprint umgesetzt werden.
- 🟡 **Mittel**: Technische Schuld, die in einem separaten Sprint angegangen wird.
- Jede Aufgabe enthält: **Betroffene Dateien**, **Aktueller Stand**, **Geplante Änderung**, **Akzeptanzkriterien**, **Abhängigkeiten**.

---

## Phase 1: Kritische Sicherheitsfixes (Sofort – vor dem nächsten Release)

### 1.1 CORS auf Tauri-Origin beschränken

**Priorität**: 🔴 Kritisch
**Betroffene Datei**: `backend/tarscribe_backend/main.py`

#### Aktueller Stand

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

#### Problem

Jede im Browser geöffnete Webseite kann Anfragen an den lokalen Backend-Port schicken. In Kombination mit dem im Frontend sichtbaren Token ist das ein Localhost-CSRF/Remote-Attack-Vektor.

#### Geplante Änderung

1. `allow_origins` dynamisch aus den erlaubten Tauri-Origins bilden:
   - **Produktion (macOS)**: `tauri://localhost`
   - **Produktion (Windows)**: `https://tauri.localhost`
   - **Dev (Vite)**: `http://localhost:5173`
   - **Dev (Tauri)**: zusätzlich `http://localhost:<tauri-dev-port>`
2. Konfigurierbar über Umgebungsvariable `TARSCRIBE_ALLOWED_ORIGINS` (Komma-getrennt).
3. `allow_credentials=True` beibehalten, aber nur sinnvoll mit `allow_origins != ["*"]`.
4. Im Browser-Dev-Modus (ohne Tauri) sollte eine Warnung im Backend-Log erscheinen.

#### Beispielimplementierung

```python
import os
from fastapi.middleware.cors import CORSMiddleware

def _allowed_origins() -> list[str]:
    env = os.environ.get("TARSCRIBE_ALLOWED_ORIGINS")
    if env:
        return [o.strip() for o in env.split(",") if o.strip()]
    return [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://localhost:5173",
        "http://localhost:1420",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Tarscribe-Token"],
)
```

#### Akzeptanzkriterien

- [x] Ein `fetch()` von `https://evil.example.com` an `http://127.0.0.1:<port>/api/...` wird mit `CORS error` abgelehnt.
- [x] Die Desktop-App funktioniert weiterhin (Dev + Produktion).
- [x] Neuer Test `backend/tests/test_cors.py` prüft Preflight-Responses für erlaubte und verweigerte Origins.
- [x] `README.md` und `AGENTS.md` dokumentieren die neue Umgebungsvariable.

#### Abhängigkeiten

Keine.

---

### 1.2 Unauthentifizierte System-Endpunkte schließen

**Priorität**: 🔴 Kritisch
**Betroffene Datei**: `backend/tarscribe_backend/routers/system.py`

#### Aktueller Stand

Folgende Endpunkte haben **kein** `require_token`:

- `GET /api/system/health`
- `GET /api/system/hardware`
- `GET /api/system/setup-status`
- `POST /api/system/complete-setup`
- `POST /api/system/warmup`

Nur `GET /api/system/models` ist geschützt.

#### Problem

- `POST /api/system/warmup` lädt das ASR-Modell und verbraucht GPU/RAM/CPU – unauthentifiziertes DoS.
- `POST /api/system/complete-setup` kann den First-Run-Wizard vorzeitig als abgeschlossen markieren.
- `/hardware` gibt detaillierte Systeminfos preis.

#### Geplante Änderung

1. Router-Level Dependency hinzufügen:
   ```python
   from fastapi import APIRouter, Depends
   from ..security import require_token

   router = APIRouter(prefix="/api/system", dependencies=[Depends(require_token)])
   ```
2. Ausnahme für `/health`: Diese Route sollte **read-only** und **minimal** bleiben, damit Tauri/Sidecar die Readiness prüfen kann. Sie wird explizit aus der Router-Dependency ausgenommen oder in einen separaten ungeschützten Router verschoben.
3. `/health` liefert nur noch `{"status":"ok"}` und keine Versions-/Hardware-Informationen.
4. `/warmup`, `/complete-setup`, `/setup-status`, `/hardware` werden zwingend geschützt.

#### Akzeptanzkriterien

- [x] `POST /api/system/warmup` ohne Token → `401 Unauthorized`.
- [x] `POST /api/system/complete-setup` ohne Token → `401 Unauthorized`.
- [x] `GET /api/system/hardware` ohne Token → `401 Unauthorized`.
- [x] `GET /api/health` ist ohne Token erreichbar, liefert aber nur `{"status":"ok"}`.
- [x] Tauri-Sidecar-Readiness-Check wird auf `GET /api/health` umgestellt.
- [x] `backend/tests/test_system_auth.py` testet jeden System-Endpunkt mit und ohne Token.

#### Abhängigkeiten

- 1.1 CORS-Beschränkung, damit der Browser-Dev-Modus weiter funktioniert.
- Anpassung in `desktop/src-tauri/src/sidecar.rs` (Readiness-URL).

---

### 1.3 CSP in Tauri aktivieren

**Priorität**: 🔴 Kritisch
**Betroffene Datei**: `desktop/src-tauri/tauri.conf.json`

#### Aktueller Stand

```json
"csp": null
```

#### Problem

Inline-Skripte, `eval()`, `new Function()` etc. sind erlaubt. Das verstärkt das Risiko, dass ein kompromittiertes Frontend-Plugin oder XSS-Schadcode ausgeführt wird.

#### Geplante Änderung

1. CSP auf einen strengen Wert setzen:
   ```json
   "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self';"
   ```
2. AudioWorklet-Code ist als statische Datei ausgelagert (`desktop/public/audioWorklet.js`), daher reicht `worker-src 'self'`.
3. Keine Inline-Event-Handler (`onclick="..."`) im JSX verwenden.

#### Akzeptanzkriterien

- [x] App startet im Dev- und Produktionsmodus ohne CSP-Verletzungen in der Konsole.
- [x] Live-Aufnahme funktioniert (AudioWorklet lädt).
- [x] Keine Inline-`<script>`- oder `eval()`-Nutzung mehr im Build.
- [x] Dokumentation der CSP in `AGENTS.md`.

#### Abhängigkeiten

- 4.3 AudioWorklet auslagern wurde umgesetzt, `blob:` ist aus `worker-src` entfernt.

---

### 1.4 WebSocket-Auth sicherer machen

**Priorität**: 🔴 Kritisch
**Betroffene Dateien**:
- `backend/tarscribe_backend/routers/ws.py`
- `desktop/src/lib/api.ts` (`connectJobs`)

#### Aktueller Stand

Token wird als Query-Parameter übergeben:
```
/ws?token=...
```

#### Problem

Das Token landet in Proxy-Logs, Browser-History und serverseitigen Access-Logs.

#### Geplante Änderung

1. **Kurzfristig**: Token zusätzlich im `Sec-WebSocket-Protocol`-Header (Subprotocol) senden, z. B. `tarscribe-auth-<token>`. Backend extrahiert es aus dem Subprotocol und ignoriert den Query-Parameter.
2. Query-Parameter-Token als veraltet markieren und nach einer Übergangsfrist entfernen.
3. Uvicorn Access-Log so konfigurieren, dass Query-Parameter gefiltert werden (oder ganz auf `access_log=False` umstellen, da ohnehin im Produktivbetrieb wenig Mehrwert).
4. **Mittelfristig**: Bei Tauri könnte Rust selbst die WebSocket-Verbindung aufbauen und nur Events an das Frontend durchreichen, sodass das Token nie im Browser-Kontext landet (siehe 2.1).

#### Akzeptanzkriterien

- [x] Token erscheint nicht mehr in Uvicorn-Access-Logs.
- [x] `backend/tests/test_ws_auth.py` funktioniert weiterhin, testet aber zusätzlich, dass ein falscher Subprotocol-Token abgelehnt wird.
- [x] `connectJobs` in `api.ts` sendet Token nicht mehr im Query-String.
- [x] Query-Parameter-Fallback ist entfernt.

#### Abhängigkeiten

- 1.2 Allgemeine Auth-Härtung.

---

## Phase 2: Hochpriorisierte Sicherheits- und Stabilitätsverbesserungen

### 2.1 Auth-Token nicht mehr ans Frontend geben

**Priorität**: 🟠 Hoch
**Betroffene Dateien**:
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/lib/api.ts`
- `backend/tarscribe_backend/main.py`
- `backend/tarscribe_backend/security.py`

#### Vorheriger Stand

- Tauri-Command `backend_config` liefert `{base_url, token}` ans Frontend.
- Frontend fügt `X-Tarscribe-Token` zu jedem Request hinzu.

#### Problem

Das Shared Secret liegt im Browser-Kontext und kann von kompromittierten Frontend-Plugins oder XSS abgegriffen werden.

#### Geplante Änderung

**Empfohlene Option A**: Tauri führt HTTP-Anfragen als Proxy durch.

1. Neuer Tauri-Command `proxy_request(method, path, body, headers)`:
   - Fügt intern das Token hinzu.
   - Führt den Request gegen das Backend aus.
   - Gibt Status, Headers und Body zurück.
2. Frontend ruft nur noch `invoke("proxy_request", ...)` auf.
3. WebSocket ebenfalls über Rust-Proxy oder Rust-basierte Event-Weiterleitung.
4. `backend_config` liefert nur noch `base_url`.

**Option B (Fallback)**: Kurzlebige Session-Cookies.
- Backend setzt nach App-Start ein HttpOnly-Cookie.
- Frontend sendet Cookie automatisch mit.
- Nachteil: Cookies sind anfälliger für CSRF, daher zusätzlich CSRF-Token nötig.

#### Akzeptanzkriterien

- [x] Im Frontend-DevTools ist das Auth-Token nicht mehr sichtbar.
- [x] `backend_config` liefert nur noch `base_url`, nicht mehr `token`.
- [x] Alle API-Requests funktionieren weiterhin.
- [x] WebSocket-Events funktionieren weiterhin.
- [x] Tests angepasst: Proxy-/Config-Regressionen sind in `backend/tests/test_auth.py` abgedeckt.

#### Abhängigkeiten

- 1.1 CORS-Beschränkung.
- 1.2 System-Endpunkte schützen.

---

### 2.2 Secrets-Handling härten

**Priorität**: 🟠 Hoch
**Betroffene Datei**: `backend/tarscribe_backend/settings_store.py`

#### Aktueller Stand

- Keyring wird für HF-Token, CalDAV-Passwort und LLM/RAG-API-Keys verwendet.
- Der alte Klartext-Fallback `.secrets.json` ist standardmäßig deaktiviert.
- Secret-Responses liefern nur Status-Flags wie `*_set`, nie Secret-Werte.
- Setup-Assistent und Einstellungen warnen, wenn kein sicherer Secret-Store verfügbar ist.

#### Problem

Wenn kein OS-Keyring verfügbar ist, dürfen HF-Token, CalDAV-Passwort und LLM/RAG-API-Keys nicht stillschweigend im Klartext auf der Platte landen. Secret-Schreibendpunkte müssen dann mit einem kontrollierten Fehler abbrechen.

#### Umgesetzte Änderung

1. **Keyring als Pflicht für Produktion**:
   - Secrets werden über `keyring` im OS-Secret-Store gespeichert.
   - Ohne sicheren Secret-Store antworten Secret-Schreibendpunkte mit HTTP 503.
   - Der Klartext-Fallback ist nur mit `TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK=1` für Dev/Test aktivierbar.
2. **Secret-Leaks in Responses vermeiden**:
   - `GET /api/settings` liefert nur noch Flags wie `hf_token_set: true/false`, nie den Wert.
   - `PUT /api/settings/hf-token`, `/caldav-password`, `/llm/api-key`, `/rag/api-key` akzeptieren den Wert, speichern ihn im Keyring und antworten nur mit `saved: true`.
3. **Nutzer warnen**:
   - Im Setup-Assistenten prüfen, ob Keyring funktioniert.
   - In Setup und Einstellungen warnen, wenn kein sicherer Secret-Store verfügbar ist.

#### Akzeptanzkriterien

- [x] `GET /api/settings` liefert keine Secrets mehr.
- [x] `PUT /api/settings/caldav-password` speichert im Keyring, ohne das Passwort zu loggen.
- [x] Fallback-Datei ist deaktiviert (`TARSCRIBE_ALLOW_INSECURE_SECRET_FALLBACK=1` nur für Dev/Test).
- [x] `backend/tests/test_settings_secrets.py` prüft, dass Secrets nicht im Response landen.
- [x] Setup-Assistent warnt bei fehlendem Keyring.

#### Abhängigkeiten

- 2.1 Token nicht ans Frontend geben.

---

### 2.3 Upload-Validierung und Path-Traversal-Härtung

**Priorität**: 🟠 Hoch
**Betroffene Dateien**:
- `backend/tarscribe_backend/routers/recordings.py`
- `backend/tarscribe_backend/routers/documents.py`
- `backend/tarscribe_backend/routers/export.py`

#### Aktueller Stand

- Upload-Endungen werden gegen zentrale Whitelists validiert.
- `import-local` erlaubt nur absolute Pfade innerhalb des Native-Capture-Ordners.
- Dokumente werden unter `documents/<id><suffix>` gespeichert; Downloads rekonstruieren den Pfad aus ID + Endung.
- `send-to-folder` verlangt einen absoluten, existierenden Export-Ordner und schreibt nur darunter.

#### Problem

- Ausführbare Dateien können unter gültigem Namen im Speicher landen.
- Manipulation der DB-Spalte `file_path` könnte beliebige Dateien ausliefern.
- `send-to-folder` könnte Dateien an beliebige Orte kopieren.

#### Geplante Änderung

1. **Whitelist für Dateiendungen**:
   - Audio: `.wav`, `.mp3`, `.m4a`, `.ogg`, `.webm`, `.flac`, `.aac`, `.mov`, `.mp4`
   - Dokumente: `.pdf`, `.txt`, `.text`, `.md`, `.markdown`, `.docx`, `.epub`, `.html`, `.htm`
2. **Dateiname nur für Anzeige**: Speichername bleibt intern bestimmt (`audio/<uuid>.wav`, `documents/<id><suffix>`).
3. **`import-local` verschärfen**:
   - Nur absolute Pfade erlauben.
   - `Path(path).resolve()` verwenden.
   - Gegen den Native-Capture-Ordner als Allow-List prüfen.
4. **`send-to-folder` validieren**:
   - `topic.export_path` darf nicht leer sein.
   - Prüfen, dass Ziel innerhalb eines vom Nutzer explizit gewählten Verzeichnisses liegt.
5. **`download_document` sicher machen**:
   - Statt `document.file_path` direkt zu streamen, Pfad aus eigenem Speicher-Schema rekonstruieren: `<data_dir>/documents/<id><suffix>`.

#### Akzeptanzkriterien

- [x] Upload einer Datei mit Endung `.exe` wird mit `400 Bad Request` abgelehnt.
- [x] `import-local` mit Pfad `../../etc/passwd` wird abgelehnt.
- [x] `send-to-folder` in nicht konfigurierten Pfad wird abgelehnt.
- [x] Dokumenten-Download funktioniert, auch wenn `file_path`-DB-Eintrag manipuliert wurde.
- [x] `backend/tests/test_upload_security.py` deckt alle Fälle ab.

#### Abhängigkeiten

Keine.

---

### 2.4 HF-Token-Validierung korrigieren

**Priorität**: 🟠 Hoch
**Betroffene Datei**: `backend/tarscribe_backend/routers/settings.py`

#### Aktueller Stand

`PUT /api/settings/hf-token` ruft `whoami()` auf und speichert den Token nur bei erfolgreicher Validierung.

#### Problem

Nutzer bemerkt möglicherweise nicht, dass ein ungültiges/wertloses Token hinterlegt wurde.

#### Umgesetzte Änderung

- Bei Validierungsfehler **nicht** speichern und klaren Fehler zurückgeben.
- Ungültige Tokens antworten mit `400 Bad Request` und `saved: false`.
- Frontend markiert fehlgeschlagene Validierung nicht mehr als gespeicherten Token.

#### Akzeptanzkriterien

- [x] `PUT /api/settings/hf-token` mit ungültigem Token → `400 Bad Request`, `saved: false`.
- [x] Gültiges Token wird gespeichert und `saved: true` zurückgegeben.
- [x] Test `test_hf_token_validation.py` ergänzt.

#### Abhängigkeiten

Keine.

---

### 2.5 Endlosschleife in `waitForFinalTranscription` beheben

**Priorität**: 🟠 Hoch
**Betroffene Datei**: `desktop/src/hooks/useRecording.tsx`

#### Aktueller Stand

`waitForFinalTranscriptionJob` pollt mit Timeout, bricht bei fehlendem Job ab und respektiert ein `AbortSignal`.

#### Problem

Keine maximale Wartezeit. Wenn das Backend abstürzt oder der Job nicht existiert, läuft die Schleife endlos.

#### Umgesetzte Änderung

1. Timeout hinzufügen (z. B. 30 Minuten, konfigurierbar).
2. Wenn Job nicht gefunden wird, abbrechen und Fehler anzeigen.
3. `AbortController` verwenden, damit bei Komponenten-Unmount aufgehört wird.

#### Akzeptanzkriterien

- [x] Nach Timeout wird Zustand auf `failed` gesetzt und Toast angezeigt.
- [x] Bei Komponenten-Unmount wird Polling gestoppt.
- [x] Test im Frontend (`finalTranscriptionPolling.test.ts`) ergänzt.

#### Abhängigkeiten

Keine.

---

## Phase 3: Architektur-Refactoring im Backend

### 3.1 Globale Auth-Dependency statt per-Route

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `backend/tarscribe_backend/main.py`
- Alle `backend/tarscribe_backend/routers/*.py`

#### Aktueller Stand

`require_token` wird zentral in `main.py` beim Einhängen aller geschützten API-Router gesetzt. `/api/health` bleibt als einzige öffentliche API-Route separat registriert.

#### Umgesetzte Änderung

1. Beim Einhängen der Router Default-Dependencies setzen:
   ```python
   app.include_router(system.router, dependencies=[Depends(require_token)])
   ```
2. Router- und Route-Level-Auth-Dependencies aus den Fachroutern entfernen.
3. `require_token` akzeptiert Header, Cookie oder Subprotocol-Header.

#### Akzeptanzkriterien

- [x] Kein Router vergisst mehr das Token.
- [x] Neue Routen sind automatisch geschützt.
- [x] `backend/tests/test_auth.py` durchläuft alle registrierten Routen und prüft 401 ohne Token.

#### Abhängigkeiten

- 1.2 System-Endpunkte schützen.

---

### 3.2 Manuelle Cascades durch DB-Cascades ersetzen

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `backend/tarscribe_backend/models.py`
- `backend/tarscribe_backend/routers/recordings.py`
- `backend/tarscribe_backend/routers/topics.py`

#### Aktueller Stand

`delete_recording` löscht Transkripte, Wörter, Diarisierungen, Zusammenfassungen, Action-Items, Kapitel, Threads, RAG-Chunks und Jobs manuell.

#### Geplante Änderung

1. In SQLModel-Beziehungen `cascade="all, delete-orphan"` und `passive_deletes=True` verwenden.
2. `delete_recording` vereinfachen: nur `session.delete(recording)` aufrufen.
3. `delete_topic` sollte ebenfalls Cascades nutzen, aber weiterhin blockieren, wenn Recordings existieren (oder diese ebenfalls kaskadieren, falls gewünscht).
4. Migration erstellen, um bestehende Fremdschlüssel-Constraints zu prüfen.

#### Akzeptanzkriterien

- [x] Löschen einer Aufnahme entfernt alle abhängigen Datensätze.
- [x] Keine verwaisten Datensätze mehr in der DB.
- [x] Alle bestehenden Tests bestehen.
- [x] Neuer Test `test_delete_cascade.py` prüft alle abhängigen Entitäten.

#### Abhängigkeiten

Keine.

---

### 3.3 Job-Runner async-konform machen

**Priorität**: 🟡 Mittel
**Betroffene Datei**: `backend/tarscribe_backend/jobs.py`

#### Aktueller Stand

`ThreadPoolExecutor` für ASR/Diarisierung/Summaries/etc. LLM-Calls werden aus Worker-Threads heraus aufgerufen.

#### Problem

Async/Sync-Mix ist schwer testbar. Cancel-Handling während eines LLM-Calls ist unklar.

#### Geplante Änderung

1. Entscheidung: CPU-Last bleibt in `ThreadPoolExecutor`, I/O-Last wird `async`.
2. `asyncio.run_coroutine_threadsafe()` für LLM-Calls aus Worker-Threads.
3. Klare Trennung zwischen `executor` (CPU) und `asyncio` (I/O).
4. Cancel-Handling verbessern: Future korrekt canceln und Modelle entladen.

#### Akzeptanzkriterien

- [x] LLM-Jobs blockieren den CPU-Executor nicht.
- [x] Cancel während LLM-Call beendet den HTTP-Request.
- [x] Keine `RuntimeError: Event loop is closed`-Fehler mehr.
- [x] Tests für Cancel-Szenarien ergänzt.

#### Abhängigkeiten

Keine.

---

### 3.4 Live-Audio-Pfade konsolidieren

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `backend/tarscribe_backend/routers/live_recordings.py`
- `backend/tarscribe_backend/live_audio.py`
- `backend/tarscribe_backend/live_analysis.py`

#### Aktueller Stand

Es gibt `live_recordings.py` (neuer Router) und `live_audio.py` (legacy WebSocket). Beide behandeln PCM-Chunks.

#### Geplante Änderung

1. `live_audio.py` (legacy WebSocket) entfernen oder als Deprecation markieren.
2. Alle PCM-Verarbeitung über `live_recordings.py` + `live_analysis.py`.
3. Gemeinsame Hilfsfunktionen für PCM-Append, WAV-Extraktion, Cleanup in `audio_utils.py` auslagern.

#### Akzeptanzkriterien

- [x] Keine doppelte Logik mehr.
- [x] Tests für `live_recordings.py` bestehen weiterhin.
- [x] Legacy-WebSocket-Route gibt ggf. `410 Gone` zurück.

#### Abhängigkeiten

Keine.

---

### 3.5 MCP-Registrierung aus der API herausnehmen

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `backend/tarscribe_backend/routers/mcp.py`
- `backend/tarscribe_backend/mcp_link.py`
- `desktop/src-tauri/src/lib.rs`

#### Aktueller Stand

Die HTTP-API kann MCP-Host-Config-Dateien im Home-Verzeichnis schreiben/löschen.

#### Geplante Änderung

1. MCP-Host-Registrierung in die Tauri-Rust-Shell oder ein Setup-CLI verschieben.
2. API liefert nur noch Status/Info (`GET /api/mcp/info`, `GET /api/mcp/diagnostics`).
3. UI-Button für Registrierung ruft Tauri-Command auf, das Rust-seitig die Config-Dateien ändert.
4. Oder: Registrierung erfordert zusätzliche Bestätigung im UI und wird in einem Audit-Log festgehalten.

#### Akzeptanzkriterien

- [x] `POST /api/mcp/register/{target}` ist entfernt oder erfordert UI-Confirmation.
- [x] MCP-Config-Dateien werden nur noch durch vertrauenswürdige Shell-Aufrufe geändert.
- [x] Tests angepasst.

#### Abhängigkeiten

- 2.1 Token-Härtung.

---

## Phase 4: Frontend-Modernisierung

### 4.1 Riesige Komponenten aufteilen

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `desktop/src/App.tsx`
- `desktop/src/components/SettingsModal.tsx`
- `desktop/src/components/RecordingDetail.tsx`

#### Aktueller Stand

- `App.tsx`: 294 Zeilen, Layout/Bootstrap in eigene Hooks und Layout-Komponenten ausgelagert.
- `SettingsModal.tsx`: 229 Zeilen, Kategorien in eigene Tab-Komponenten ausgelagert.
- `RecordingDetail.tsx`: 299 Zeilen, Toolbar, Tabs, Transcript, Summary, Ask und Speaker-Workspaces ausgelagert.
- `ChatPanel.tsx`: 121 Zeilen, Markdown, Toolbar, Suche, Chat-Ansicht, Composer und State-Hook ausgelagert.
- Weitere Frontend-Komponenten über 300 Zeilen bereinigt (`LlmSettings`, `TasksPage`, `LiveRecordingDetail`).

#### Geplante Änderung

1. `App.tsx` aufteilen:
   - `Sidebar.tsx`
   - `TopicList.tsx`
   - `TopicRow.tsx`
   - `TopBar.tsx`
   - `LayoutProvider.tsx`
2. `SettingsModal.tsx` pro Kategorie eigene Tab-Komponenten:
   - `RecordingSettingsTab.tsx`
   - `LlmSettingsTab.tsx`
   - `RagSettingsTab.tsx`
   - `LiveSettingsTab.tsx`
   - `CalendarSettingsTab.tsx`
3. `RecordingDetail.tsx` aufteilen in:
   - `TranscriptPanel.tsx`
   - `SummaryPanel.tsx`
   - `ChatPanel.tsx` (stärker entkoppeln)
   - `SpeakersPanel.tsx`
   - `RecordingToolbar.tsx`

#### Akzeptanzkriterien

- [x] Keine Komponente > 300 Zeilen.
- [x] Storybook oder isolierte Unit-Tests für jede Subkomponente.
- [x] Keine Regression in der UI.

#### Abhängigkeiten

Keine.

---

### 4.2 Zentrale Download-Hilfe

**Priorität**: 🟡 Mittel
**Betroffene Datei**: `desktop/src/lib/api.ts`

#### Aktueller Stand

Duplizierte Blob/Anchor-Logik für Downloads.

#### Geplante Änderung

- Funktion `downloadBlob(url: string, filename: string, options?: RequestInit)` einführen.
- Ersetzt duplizierte Logik bei:
  - `openDocument`
  - `downloadActionItemsIcs`
  - `downloadChapters`
  - `downloadExport`
  - `downloadAudio`

#### Akzeptanzkriterien

- [x] Alle Downloads nutzen `downloadBlob`.
- [x] Keine Code-Duplikation mehr.
- [x] Auth-Header wird zentral angehängt.

#### Abhängigkeiten

Keine.

---

### 4.3 AudioWorklet auslagern

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `desktop/src/lib/livePcmCapture.ts`
- `desktop/public/audioWorklet.js` (neu)

#### Aktueller Stand

AudioWorklet wird als statische Datei `desktop/public/audioWorklet.js` geladen.

#### Geplante Änderung

1. Inline-Blob-Worklet in separate Datei `public/audioWorklet.js` auslagern.
2. `livePcmCapture.ts` lädt `new URL('/audioWorklet.js', import.meta.url)`.
3. CSP kann dann `worker-src 'self'` (ohne `blob:`) verwenden.

#### Akzeptanzkriterien

- [x] CSP kann `worker-src 'self'` verwenden.
- [x] Live-Aufnahme funktioniert in Dev und Produktion.

#### Abhängigkeiten

- 1.3 CSP aktivieren.

---

### 4.4 Formularzustände kontrolliert machen

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `desktop/src/components/SettingsModal.tsx`
- `desktop/src/components/TopicModal.tsx`
- `desktop/src/components/FirstRunWizard.tsx`

#### Aktueller Stand

Kontrollierte Formularzustände sind für Topic-Erstellung, First-Run-HF-Token,
CalDAV, Chat-LLM und RAG umgesetzt. URL-Felder validieren `http://`/`https://`
vor dem Senden und zeigen Feldfehler direkt am Eingabefeld.

#### Geplante Änderung

1. Stattdessen `useState` für jedes Feld, zentrales `onSubmit`.
2. Validierung vor dem Senden (z. B. URL-Format für CalDAV/LLM base_url).
3. Deaktivieren des Submit-Buttons bei ungültigen Eingaben.

#### Akzeptanzkriterien

- [x] Kein Datenverlust bei schneller Eingabe.
- [x] URL-Felder validieren das Schema.
- [x] Fehler werden pro Feld angezeigt.

#### Abhängigkeiten

- 4.1 Komponenten-Aufteilung.

---

### 4.5 TypeScript strikter machen

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `desktop/src/hooks/queries.ts`
- `desktop/src/hooks/useRecording.tsx`
- `desktop/src/components/*.tsx`
- `desktop/tsconfig.json`

#### Aktueller Stand

`strict` ist in `desktop/tsconfig.json` aktiv. Die sichtbaren Non-Null-Assertions
in Query-/Chat-/Recording-Pfaden und die `any`-Typen im Markdown-Citation-Plugin
sind entfernt.

#### Geplante Änderung

1. `tsconfig.json` auf `strict: true` stellen.
2. Non-Null-Assertions entfernen.
3. Nullable-Typen korrekt behandeln.

#### Akzeptanzkriterien

- [x] `npm run typecheck` (oder `tsc --noEmit`) läuft ohne Fehler.
- [x] Keine `any`-Typen mehr in neuem Code.

#### Abhängigkeiten

- 4.1, 4.4

---

## Phase 5: Tests, Monitoring und Prozesse

### 5.1 Security-Regressionstests ergänzen

**Priorität**: 🟠 Hoch
**Neue Dateien**:
- `backend/tests/test_auth.py`
- `backend/tests/test_cors.py`
- `backend/tests/test_upload_security.py`
- `backend/tests/test_settings_secrets.py`

#### Geplante Tests

1. **Auth-Coverage**: Für jede registrierte Route prüfen, dass ohne Token 401 kommt (außer explizit erlaubte).
2. **CORS**: Preflight von fremder Origin wird abgelehnt.
3. **Upload-Security**: Falsche Endungen, Path-Traversal-Namen, übergroße Dateien.
4. **Secrets**: `GET /api/settings` enthält keine Klartext-Secrets.
5. **WebSocket**: Verbindung ohne/falsches Token wird abgelehnt.
6. **Path-Traversal**: `import-local`, `send-to-folder`, `download_document`.

#### Stand

- Auth- und System-Routen-Regressionen sind über `backend/tests/test_auth.py` und `backend/tests/test_system_auth.py` abgedeckt.
- CORS-Preflights und Origin-Grenzen sind über `backend/tests/test_cors.py` abgedeckt.
- WebSocket-Auth inklusive Ablehnung von Query-Token ist über `backend/tests/test_ws_auth.py` abgedeckt.
- Upload-, Secrets- und Path-Traversal-Regressionen sind über `backend/tests/test_upload_security.py` und `backend/tests/test_settings_secrets.py` abgedeckt.

#### Akzeptanzkriterien

- [x] Alle neuen Tests sind grün.
- [x] CI führt sie automatisch aus.

#### Abhängigkeiten

- 1.1, 1.2, 1.4, 2.2, 2.3

---

### 5.2 Integrationstests für kritische User-Journeys

**Priorität**: 🟡 Mittel
**Neue Dateien**:
- `backend/tests/test_journey_record_summarize.py`
- `backend/tests/test_journey_rag_chat.py`
- `backend/tests/test_journey_delete_topic.py`

#### Geplante Journeys

1. Aufnahme starten → pausieren → fortsetzen → stoppen → Transkription → Zusammenfassung (`test_journey_record_summarize.py`).
2. Dokument hochladen → indexieren → RAG-Chat (`test_journey_rag_chat.py`).
3. Thema löschen → topic-eigene Daten weg, Chat-Historie bleibt erhalten (`test_journey_delete_topic.py`).
4. Live-Session finish → finale Transkription korrekt.

#### Akzeptanzkriterien

- [x] Mind. 3 End-to-End-Journeys abgedeckt.
- [x] Tests laufen in < 5 Minuten.

#### Abhängigkeiten

- 3.2 DB-Cascades
- 3.3 Job-Runner async

---

### 5.3 Logging und Audit-Trail

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `backend/tarscribe_backend/main.py`
- `backend/tarscribe_backend/security.py`
- `backend/tarscribe_backend/routers/*.py`

#### Geplante Änderung

1. Auth-Fehler werden ohne Token-Wert als strukturierte Events geloggt.
2. Uploads/Downloads/Löschungen/Exporte und MCP-Registrierungen werden mit Zeitpunkt, Pfad und lokalem Client erfasst.
3. Das Audit-Log rotiert nach konfigurierbarer Größe und Backup-Anzahl.
4. Die separate JSONL-Datei liegt standardmäßig unter `logs/audit.log`.

#### Akzeptanzkriterien

- [x] Jede nicht-erfolgreiche Auth-Anfrage wird geloggt.
- [x] Keine Secrets in Logs.
- [x] Audit-Log ist rotierend und überschreibbar.

#### Abhängigkeiten

- 1.2 System-Endpunkte schützen.

---

### 5.4 Dependency-Update-Prozess

**Priorität**: 🟡 Mittel
**Betroffene Dateien**:
- `desktop/package.json`
- `backend/pyproject.toml`
- `desktop/src-tauri/Cargo.toml`
- `.github/dependabot.yml` (neu) oder `.github/renovate.json` (neu)

#### Geplante Änderung

1. Dependabot aktualisiert npm, uv, Cargo und GitHub Actions monatlich.
2. Ein monatlicher Workflow legt eine Security-Review-Checkliste als GitHub-Issue an.
3. Direkte Backend-Kernabhängigkeiten haben Major-Bounds; Tauri/npm/Cargo bleiben über ihre Manifest-Semantik major-gebunden.

#### Akzeptanzkriterien

- [x] Automatische PRs für Patch/Minor-Updates.
- [x] Major-Updates manuelles Review.
- [x] Security-Advisories werden monatlich geprüft.

#### Abhängigkeiten

Keine.

---

## 6. Rollout-Plan und Abhängigkeiten

### Sprint 0: Vorbereitung

- [x] Sicherheits-Audit durchführen (`SECURITY_AUDIT.md`).
- [x] Sicherheits-Audit genehmigen (`SECURITY_AUDIT.md`).
- [x] CI-Pipeline um Security-Tests erweitern.
- [x] Branching-Strategie festlegen (`.github/BRANCHING_STRATEGY.md`).

### Sprint 1: Kritisch

- [x] 1.1 CORS beschränken
- [x] 1.2 System-Endpunkte schützen
- [x] 1.3 CSP aktivieren
- [x] 1.4 WebSocket-Auth härten
- [x] 5.1 Security-Regressionstests für Sprint-1-Fixes

### Sprint 2: Hoch

- [x] 2.1 Token nicht ans Frontend geben
- [x] 2.2 Secrets härten
- [x] 2.3 Upload/Path-Traversal-Härtung
- [x] 2.4 HF-Token-Validierung
- [x] 2.5 Endlosschleife beheben

### Sprint 3: Architektur Backend

- [x] 3.1 Globale Auth-Dependency
- [x] 3.2 DB-Cascades
- [x] 3.3 Job-Runner async
- [x] 3.4 Live-Audio konsolidieren

### Sprint 4: Architektur Frontend

- [x] 4.1 Komponenten aufteilen
- [x] 4.2 Download-Hilfe
- [x] 4.3 AudioWorklet auslagern
- [x] 4.4 Formularzustände
- [x] 4.5 Strict TypeScript

### Sprint 5: Qualität

- [x] 3.5 MCP aus API herausnehmen
- [x] 5.2 Integrationstests
- [x] 5.3 Logging/Audit
- [x] 5.4 Dependency-Updates

---

## 7. Risiken und Gegenmaßnahmen

| Risiko | Wahrscheinlichkeit | Auswirkung | Gegenmaßnahme |
|--------|-------------------|------------|---------------|
| CSP aktiviert → AudioWorklet bricht | mittel | hoch | Vorab testen, Worklet als Datei auslagern (4.3) |
| Auth für alle Routen → Dev-Modus kaputt | mittel | mittel | CORS + Auth-Dependency korrekt für Dev konfigurieren |
| Token nicht ans Frontend → umfangreiche Rust-Änderungen | hoch | mittel | Option B (Session-Cookie) als Zwischenschritt |
| DB-Cascades → Datenverlust bei falscher Konfiguration | niedrig | hoch | Backup-Mechanismus + Migrationstests |
| MCP aus API entfernen → bestehende Workflows brechen | niedrig | mittel | Migrationsanleitung + neues UI für Registrierung |
| CORS zu streng → Browser-Dev funktioniert nicht | mittel | mittel | `TARSCRIBE_ALLOWED_ORIGINS` für Dev setzen |

---

## 8. Nächste Schritte (sofort umsetzbar)

1. **Branch `security/sprint-1`** anlegen.
2. **CORS-Beschränkung** implementieren (Task 1.1).
3. **System-Endpunkte schützen** (Task 1.2).
4. **Tests** für 1.1 + 1.2 schreiben.
5. **PR erstellen** und Review durchführen.

---

## 9. Dokumentationspflege

Nach jedem abgeschlossenen Sprint müssen folgende Dateien aktualisiert werden:

- `README.md` – Nutzer-relevante Änderungen
- `AGENTS.md` – Agent-relevante Konventionen (CSP, Auth, Dev-Modus)
- `ROADMAP.md` – dieses Dokument: erledigte Tasks markieren und verschieben

---

*Dieser Plan wurde am 24.06.2026 erstellt und sollte nach jedem Sprint aktualisiert werden.*

# Tarscribe Security Audit

**Datum:** 27.06.2026
**Scope:** Lokale FastAPI-Sidecar-API, Tauri-Shell, React-Frontend, SQLite-Datenhaltung,
Datei-Uploads, Secrets, WebSocket, MCP-Integration und Build-/Update-Prozess.

## Ergebnis

Die technischen Maßnahmen aus `ROADMAP.md` sind umgesetzt. Die lokale API ist auf
Tauri-/Dev-Origins begrenzt, alle privaten REST-Routen und der WebSocket sind
authentifiziert, das Backend-Token bleibt im Rust-Prozess und Secrets werden über
den OS-Secret-Store verwaltet.

Uploads und lokale Pfade werden zentral validiert. Dokument-Downloads verwenden
kanonische Speicherpfade. Datenbank-Cascades, async-konforme Job-Ausführung,
kontrollierte Formulare und TypeScript-Strictness reduzieren zusätzliche Fehler-
und Datenverlust-Risiken.

Security-relevante Aktionen werden ohne Request-Bodies oder Credentials in einem
separaten, rotierenden JSONL-Audit-Log erfasst.

## Verifikation

- Backend: 221 Tests grün, inklusive Auth, CORS, WebSocket, Secrets, Upload-/Pfadgrenzen,
  Cascades, Audit-Log und drei kritischen User-Journeys.
- Backend: Ruff ohne Befund.
- Frontend: 22 Vitest-Tests grün.
- Frontend: TypeScript strict und Production-Build erfolgreich.
- Dependency-Prozess: monatliche Patch-/Minor-PRs für npm, uv, Cargo und GitHub Actions;
  Major-Updates bleiben im manuellen Review.

## Verbleibende Risiken

- Das lokale Audit-Log ist rotierend und redigiert, aber nicht kryptografisch
  manipulationssicher.
- Die macOS-App ist ad-hoc signiert und nicht Apple-notarisiert; die bestehende
  Installationsdokumentation muss weiterhin klar auf Gatekeeper-Schritte hinweisen.
- Externe LLM-/Embedding-Endpoints liegen außerhalb der lokalen Vertrauensgrenze.
  Nutzer müssen Anbieter, Datenschutz und Datenübertragung selbst bewerten.
- Der Testlauf zeigt eine Deprecation-Warnung für Starlettes bisherigen
  `httpx`-TestClient-Pfad; aktuell besteht keine funktionale Regression.
- GitHub-Dependabot-Alerts und der monatliche Review-Workflow wirken erst nach
  Übernahme der Dateien in den Default-Branch.

## Genehmigung

Status: **Genehmigt am 01.07.2026 für Release v0.12.0.**

Die Freigabe erfolgte nach Review des Berichts, vollständiger technischer
Verifikation und Abnahme der lokalen Test-App.

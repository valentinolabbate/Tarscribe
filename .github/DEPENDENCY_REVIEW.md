# Monatlicher Dependency-Security-Review

Der Review wird am ersten Tag jedes Monats durch den Workflow
`dependency-security-review.yml` als GitHub-Issue angelegt.

## Checkliste

- Dependabot- und GitHub-Security-Advisories prüfen und priorisieren.
- Offene npm-, uv-, Cargo- und GitHub-Actions-PRs prüfen.
- Major-Updates einzeln auf Breaking Changes, Migrationen und Security-Auswirkungen bewerten.
- Backend-, Frontend- und Rust-CI für angenommene Updates ausführen.
- Release Notes sicherheitsrelevanter Kernabhängigkeiten prüfen:
  FastAPI, Uvicorn, Pydantic, httpx, keyring, Tauri und Rustls/Reqwest.
- Ergebnis, verschobene Updates und akzeptierte Risiken im Monats-Issue dokumentieren.

Automatische Dependabot-PRs sind auf Patch- und Minor-Updates begrenzt.
Major-Updates bleiben Teil dieses manuellen Reviews.

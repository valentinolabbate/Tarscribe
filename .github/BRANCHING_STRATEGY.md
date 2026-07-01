# Branching-Strategie

`main` bleibt jederzeit releasefähig. Änderungen werden über kurzlebige Branches
und Pull Requests integriert; direkte Feature- oder Security-Commits auf `main`
sind nicht vorgesehen.

## Namen

- Security-Sprint: `codex/security-sprint-<nummer>-<slug>`
- Security-Hotfix: `codex/security-hotfix-<slug>`
- Wartung/Refactoring: `codex/maintenance-<slug>`
- Dependency-Updates: Dependabot-Standardbranches

## Ablauf

1. Branch vom aktuellen `main` erstellen.
2. Änderungen eng auf den Task begrenzen.
3. Backend-Tests/Ruff, Frontend-Tests/Build und bei Rust-Änderungen `cargo check` ausführen.
4. Pull Request mit Risiko, Testnachweis und Rollback-Hinweis öffnen.
5. CI und Review abwarten.
6. Nach Freigabe squash-mergen und Branch löschen.

Security-Hotfixes dürfen beschleunigt reviewed werden, müssen aber dieselben
automatisierten Checks bestehen. Releases werden weiterhin ausschließlich über
versionierte Tags aus `main` erzeugt.

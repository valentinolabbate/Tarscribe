# Releases & Auto-Updates (macOS)

Tarscribe aktualisiert sich selbst: Beim Start prüft die App gegen **GitHub Releases**,
ob eine neuere, signierte Version vorliegt. Falls ja, **poppt ein Update-Fenster auf**
und das **Status-Item in der Menüleiste** zeigt einen Punkt (●) mit Tooltip
„Update verfügbar". Nutzer klicken „Jetzt installieren & neu starten" — fertig.

## Einmalige Einrichtung

1. **Repository anlegen** und Code pushen (GitHub).

2. **Endpoint eintragen:** In `desktop/src-tauri/tauri.conf.json` unter
   `plugins.updater.endpoints` `OWNER/REPO` durch deinen GitHub-Nutzer und das
   Repo ersetzen, z. B.:
   ```
   https://github.com/valentino/tarscribe/releases/latest/download/latest.json
   ```

3. **Signaturschlüssel als Secrets hinterlegen** (Repo → Settings → Secrets and
   variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` = **Inhalt** der Datei
     `desktop/.tauri/tarscribe-updater.key` (`cat` den Inhalt rein)
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = leer lassen (der Schlüssel hat kein Passwort)

   > ⚠️ Die Datei `desktop/.tauri/tarscribe-updater.key` ist privat und **nicht** im
   > Repo (per `.gitignore` ausgeschlossen). Bewahre sie sicher auf — ohne sie kannst
   > du keine Updates mehr signieren. Der öffentliche Schlüssel steckt bereits in
   > `tauri.conf.json` und wird mitausgeliefert.

## Neue Version veröffentlichen

1. Version erhöhen in **beiden** Dateien:
   - `desktop/src-tauri/tauri.conf.json` → `"version"`
   - `desktop/package.json` → `"version"`
2. Commit + annotierten Tag mit kurzen Release Notes pushen:
   ```bash
   git commit -am "Release v0.2.0"
   git tag -a v0.2.0 \
     -m "Kurze Zusammenfassung der wichtigsten Änderungen." \
     -m "- Verbesserung 1" \
     -m "- Bugfix 2"
   git push origin main v0.2.0
   ```
   Die Tag-Beschreibung wird als GitHub Release Notes übernommen. Falls doch ein
   Lightweight-Tag ohne Beschreibung gepusht wird, erzeugt der Workflow
   automatisch eine kurze Commit-Liste als Fallback.
3. GitHub Actions (`.github/workflows/release.yml`) baut die App auf einem
   Apple-Silicon-Runner, signiert die Update-Artefakte und erstellt automatisch
   einen Release mit `Tarscribe.app.tar.gz`, `.sig`, der `.dmg` **und** `latest.json`.

Beim nächsten Start (oder über **Menü → „Nach Updates suchen…"**) ziehen sich alle
installierten Apps das Update von selbst.

## Lokal testen (ohne CI)

```bash
cd desktop
./scripts/stage-resources.sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri/tarscribe-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```
Erzeugt signierte Updater-Artefakte unter
`desktop/src-tauri/target/release/bundle/`.

## Hinweis: ad-hoc-Signierung

Die Releases sind weiterhin **nicht** Apple-notarisiert (keine Developer ID nötig).
Beim allerersten Öffnen muss die App einmalig per Rechtsklick → „Öffnen" bestätigt
werden (siehe `SHARING.md`). **Nachfolgende Auto-Updates** laufen ohne diese
Bestätigung durch, da sie aus der bereits vertrauten App heraus installiert werden.

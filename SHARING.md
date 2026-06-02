# Tarscribe an Freunde weitergeben (macOS, ohne Apple Developer ID)

Für ein paar Leute brauchst du **keine** kostenpflichtige Apple Developer ID. Die App
wird ad-hoc-signiert gebaut und läuft nach einer einmaligen Gatekeeper-Bestätigung.

## 1. App bauen (auf deinem Mac)

```bash
cd desktop
./scripts/stage-resources.sh     # bündelt uv + Backend-Quellen
# Signaturschlüssel für die Auto-Update-Artefakte (liegt lokal in .tauri/):
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri/tarscribe-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build              # erzeugt die .app, .dmg und signierte Update-Artefakte
```

Das Ergebnis liegt unter:

```
desktop/src-tauri/target/release/bundle/dmg/Tarscribe_0.1.0_aarch64.dmg
desktop/src-tauri/target/release/bundle/macos/Tarscribe.app
```

Schick die **.dmg** (oder die gezippte **.app**) per AirDrop / USB / Download weiter.

## 2. So installieren deine Freundin / dein Kumpel die App (einmalig)

Weil die App nicht von Apple notarisiert ist, setzt macOS beim Download ein
„Quarantäne"-Flag. Bei Apple Silicon erscheint dann oft **„Tarscribe ist beschädigt"**
— das ist **kein** echter Defekt, sondern Gatekeeper. **Zuverlässigster Weg:**

1. DMG öffnen.
2. Rechtsklick auf `Tarscribe installieren.command` → **Öffnen**.
3. Falls macOS das Skript blockiert: einmalig unter **Systemeinstellungen → Datenschutz &
   Sicherheit → Trotzdem öffnen** freigeben und das Skript erneut öffnen.
4. Das Skript kopiert Tarscribe nach **Programme**, entfernt die Quarantäne-Flags und startet
   die App. Danach läuft sie normal über Finder, Launchpad und Spotlight.

> Tipp: Falls schon das **DMG** als „beschädigt" gemeldet wird, vorher
> `xattr -cr ~/Downloads/Tarscribe_*.dmg` ausführen, dann das DMG öffnen.

Der Installer ist absichtlich der einzige sichtbare Installationsweg im DMG. Die App direkt
aus dem DMG zu starten oder manuell zu kopieren erzeugt zusätzliche Gatekeeper-Freigaben.

## 3. Erster Start

Beim **allerersten** Start richtet Tarscribe sich selbst ein (lädt die KI-Modelle und
baut die Python-Umgebung auf). Das braucht **Internet** und ein paar Minuten — danach
läuft alles **vollständig offline**. Der Assistent führt durch:

1. System-Check
2. HuggingFace-Token (optional, nur für Sprecher-Trennung)
3. LLM-Server für Zusammenfassungen (optional, Ollama/LM Studio)
4. Modell-Download

## Voraussetzungen auf dem Ziel-Mac

- **Apple Silicon** (M1 oder neuer)
- **ffmpeg**: Falls der System-Check es als fehlend meldet:
  ```bash
  brew install ffmpeg
  ```

## Hinweis zur „echten" Signierung

Willst du die App später ohne jede Warnung verteilen (z. B. öffentlich), brauchst du
eine **Apple Developer ID** ($99/Jahr) für Signierung + Notarisierung. Für den
Freundeskreis ist das nicht nötig.

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

## 2. So öffnen deine Freundin / dein Kumpel die App (einmalig)

Weil die App nicht von Apple notarisiert ist, blockt macOS sie beim ersten Start.
Das ist normal — einer dieser Wege genügt:

- **Rechtsklick** auf `Tarscribe.app` → **„Öffnen"** → im Dialog nochmal **„Öffnen"**, **oder**
- **Systemeinstellungen → Datenschutz & Sicherheit** → unten bei der Tarscribe-Meldung
  auf **„Trotzdem öffnen"**, **oder**
- einmalig im Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Tarscribe.app
  ```

Danach startet die App ganz normal per Doppelklick.

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

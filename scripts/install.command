#!/usr/bin/env bash
set -euo pipefail

# Die App liegt als versteckte Nutzlast im selben DMG-Volume wie dieses Skript.
# ditto --noqtn verhindert, dass die Quarantaene des Downloads beim Kopieren
# erneut an die installierte App vererbt wird.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/.Tarscribe.app"
DEST="/Applications/Tarscribe.app"

echo ""
echo "=== Tarscribe Installer ==="
echo ""

if [[ ! -d "$SRC" ]]; then
  echo "FEHLER: Tarscribe.app nicht gefunden."
  echo "Starte dieses Skript direkt aus dem Tarscribe-DMG heraus."
  echo ""
  read -rp "Enter druecken zum Schliessen…"
  exit 1
fi

if [[ -d "$DEST" ]]; then
  echo "Bestehende Installation wird ersetzt…"
  rm -rf "$DEST"
fi

echo "Bereite Tarscribe fuer den ersten Start vor…"
/usr/bin/xattr -dr com.apple.quarantine "$SRC" 2>/dev/null || true

echo "Kopiere Tarscribe.app nach /Applications…"
/usr/bin/ditto --noqtn "$SRC" "$DEST"

/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Finder, Launchpad und Spotlight sollen die neue Installation sofort sehen.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
fi

echo ""
echo "Installation abgeschlossen. Tarscribe wird geoeffnet…"
sleep 1
/usr/bin/open "$DEST"

#!/usr/bin/env bash
set -euo pipefail

# Tarscribe.app liegt im selben DMG-Volume wie dieses Skript
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/Tarscribe.app"
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

echo "Kopiere Tarscribe.app nach /Applications…"
cp -r "$SRC" "$DEST"

echo "Entferne macOS Quarantaene-Flag…"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo ""
echo "Installation abgeschlossen. Tarscribe wird geoeffnet…"
sleep 1
open "$DEST"

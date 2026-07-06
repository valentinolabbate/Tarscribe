#!/usr/bin/env bash
# Build a Tarscribe DMG containing a hidden app payload and an install script.
# The single visible install path avoids accidental app launches from the DMG.
#
# Usage: run from the repo root after `cargo tauri build`:
#   cd desktop/src-tauri && cargo tauri build && cd ../..
#   ./scripts/build-dmg.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- Paths ---------------------------------------------------------------
INSTALL_SRC="scripts/install.command"

ARCH=$(uname -m)
[[ "$ARCH" == "arm64" ]] && ARCH_TAG="aarch64" || ARCH_TAG="x86_64"
TARGET="${ARCH_TAG}-apple-darwin"

# tauri-action builds with --target <triple> → target/<triple>/release/bundle/
# Local builds without --target → target/release/bundle/
APP="desktop/src-tauri/target/${TARGET}/release/bundle/macos/Tarscribe.app"
OUT_DIR="desktop/src-tauri/target/${TARGET}/release/bundle/dmg"
if [[ ! -d "$APP" ]]; then
  APP="desktop/src-tauri/target/release/bundle/macos/Tarscribe.app"
  OUT_DIR="desktop/src-tauri/target/release/bundle/dmg"
fi

if [[ ! -d "$APP" ]]; then
  echo "Fehler: Tarscribe.app nicht gefunden (weder target/${TARGET}/... noch target/release/...)."
  echo "Zuerst bauen: cd desktop && npx tauri build"
  exit 1
fi

# ---- Version aus tauri.conf.json -----------------------------------------
VERSION=$(python3 -c "
import json
with open('desktop/src-tauri/tauri.conf.json') as f:
    print(json.load(f)['version'])
")

DMG_PATH="$OUT_DIR/Tarscribe_${VERSION}_${ARCH_TAG}.dmg"

# ---- Staging-Verzeichnis --------------------------------------------------
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "Bereite Inhalt vor…"
cp -r "$APP" "$STAGING/.Tarscribe.app"
cp "$INSTALL_SRC" "$STAGING/Tarscribe installieren.command"
chmod +x "$STAGING/Tarscribe installieren.command"

# ---- DMG erstellen -------------------------------------------------------
mkdir -p "$OUT_DIR"
rm -f "$DMG_PATH"

echo "Erstelle DMG (${VERSION}, ${ARCH_TAG})…"
for attempt in 1 2 3; do
  if hdiutil create \
    -volname "Tarscribe $VERSION" \
    -srcfolder "$STAGING" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "$DMG_PATH"; then
    break
  fi
  if [[ "$attempt" == "3" ]]; then
    echo "Fehler: DMG konnte nach drei Versuchen nicht erstellt werden."
    exit 1
  fi
  echo "DMG-Erstellung belegt, neuer Versuch…"
  rm -f "$DMG_PATH"
  sleep 3
done

echo ""
echo "Fertig: $DMG_PATH"

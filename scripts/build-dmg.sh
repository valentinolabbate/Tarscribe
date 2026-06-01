#!/usr/bin/env bash
# Build an enhanced Tarscribe DMG containing Tarscribe.app, an /Applications
# symlink, and an install script that removes the macOS quarantine flag.
#
# Usage: run from the repo root after `cargo tauri build`:
#   cd desktop/src-tauri && cargo tauri build && cd ../..
#   ./scripts/build-dmg.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- Paths ---------------------------------------------------------------
APP="desktop/src-tauri/target/release/bundle/macos/Tarscribe.app"
OUT_DIR="desktop/src-tauri/target/release/bundle/dmg"
INSTALL_SRC="scripts/install.command"

if [[ ! -d "$APP" ]]; then
  echo "Fehler: $APP nicht gefunden."
  echo "Zuerst bauen: cd desktop/src-tauri && cargo tauri build"
  exit 1
fi

# ---- Version aus tauri.conf.json -----------------------------------------
VERSION=$(python3 -c "
import json, sys
with open('desktop/src-tauri/tauri.conf.json') as f:
    print(json.load(f)['version'])
")

ARCH=$(uname -m)
[[ "$ARCH" == "arm64" ]] && ARCH_TAG="aarch64" || ARCH_TAG="x86_64"
DMG_PATH="$OUT_DIR/Tarscribe_${VERSION}_${ARCH_TAG}.dmg"

# ---- Staging-Verzeichnis --------------------------------------------------
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "Bereite Inhalt vor…"
cp -r "$APP" "$STAGING/Tarscribe.app"
ln -s /Applications "$STAGING/Applications"
cp "$INSTALL_SRC" "$STAGING/Tarscribe installieren.command"
chmod +x "$STAGING/Tarscribe installieren.command"

# ---- DMG erstellen -------------------------------------------------------
mkdir -p "$OUT_DIR"
rm -f "$DMG_PATH"

echo "Erstelle DMG (${VERSION}, ${ARCH_TAG})…"
hdiutil create \
  -volname "Tarscribe $VERSION" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_PATH"

echo ""
echo "Fertig: $DMG_PATH"

#!/usr/bin/env bash
# Stage the files bundled into the macOS .app: the `uv` binary and the backend
# Python sources. Run before `npm run tauri build`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"           # desktop/
RES="$HERE/src-tauri/resources"
BACKEND_SRC="$HERE/../backend"

echo "==> Staging resources into $RES"
rm -rf "$RES"
mkdir -p "$RES/backend"

# 1) uv binary (resolve symlinks so we copy the real executable)
UV_BIN="$(command -v uv || true)"
if [ -z "$UV_BIN" ]; then
  echo "!! 'uv' not found on PATH. Install it: https://docs.astral.sh/uv/" >&2
  exit 1
fi
UV_REAL="$(python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$UV_BIN")"
cp "$UV_REAL" "$RES/uv"
chmod 755 "$RES/uv"   # writable by owner so rebuilds can overwrite the copy
echo "    uv     <- $UV_REAL"

# 2) backend sources (package + project metadata, no venv / caches / tests)
cp -R "$BACKEND_SRC/tarscribe_backend" "$RES/backend/tarscribe_backend"
cp "$BACKEND_SRC/pyproject.toml" "$RES/backend/pyproject.toml"
find "$RES/backend" -name "__pycache__" -type d -prune -exec rm -rf {} +
echo "    backend <- tarscribe_backend + pyproject.toml"

echo "==> Done."

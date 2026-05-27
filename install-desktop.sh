#!/usr/bin/env bash
# Install a desktop shortcut that launches hector-vector as a standalone app
# window (via launch.sh). Idempotent — re-run after moving the repo.
set -euo pipefail
APP_DIR="$(dirname "$(readlink -f "$0")")"
LAUNCH="$APP_DIR/launch.sh"
ICON="$APP_DIR/assets/icon.svg"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DEST="$DEST_DIR/hector-vector.desktop"

chmod +x "$LAUNCH" 2>/dev/null || true
mkdir -p "$DEST_DIR"

cat > "$DEST" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=hector-vector
GenericName=Vector Editor
Comment=Lean browser vector editor
Exec=$LAUNCH
Icon=$ICON
Terminal=false
Categories=Graphics;VectorGraphics;2DGraphics;
Keywords=vector;svg;editor;trace;
StartupNotify=true
StartupWMClass=hector-vector
EOF

chmod +x "$DEST" 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DEST_DIR" >/dev/null 2>&1 || true

echo "Installed: $DEST"
echo "Find it in your app grid (search \"hector-vector\"), or run: $LAUNCH"

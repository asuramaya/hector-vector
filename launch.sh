#!/usr/bin/env bash
# Launch hector-vector as a standalone Chromium app window.
#
# Boots the local server (run.sh) if it isn't already listening, then opens a
# chrome-less, resizable window pointed at it. With the bundled PWA manifest the
# OS titlebar collapses into the app header (Window-Controls-Overlay) and the
# header becomes draggable; see manifest.webmanifest + app.js. Install a desktop
# shortcut for it with ./install-desktop.sh.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-2002}"
URL="http://localhost:${PORT}/?app=1"

port_open() {
  python3 - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(0.3)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

# A CURRENT server answers /api/heartbeat with 200. A server that doesn't is
# stale (older code still bound to the port) — reusing it would serve fresh
# client JS against a mismatched API, which is the stale-server class of bug
# (e.g. /api/capabilities 404-storming the UI into an unclickable state).
server_current() {
  python3 - "$PORT" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{int(sys.argv[1])}/api/heartbeat", timeout=0.6) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
}

# Bring the server up if nothing is answering on the port — OR replace a stale
# one. run.sh kills+replaces an existing server.py on the port idempotently, so
# starting again is safe; we then wait for the NEW server to report current.
if ! port_open || ! server_current; then
  if port_open; then echo "launch.sh: replacing a stale server on :$PORT" >&2
  else echo "launch.sh: starting server on :$PORT" >&2; fi
  PORT="$PORT" nohup ./run.sh >/tmp/hector-vector-server.log 2>&1 &
  for _ in $(seq 1 150); do
    server_current && break
    sleep 0.2
  done
  server_current || { echo "launch.sh: server did not come up on :$PORT (see /tmp/hector-vector-server.log)" >&2; exit 1; }
fi

# Pick a Chromium-family browser.
BROWSER=""
for b in chromium chromium-browser google-chrome google-chrome-stable chrome brave-browser brave; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$(command -v "$b")"; break; fi
done
[ -n "$BROWSER" ] || { echo "launch.sh: no Chromium/Chrome found in PATH" >&2; exit 1; }

# Dedicated profile so the app window stays separate from normal browsing and
# gets its own taskbar identity. Snap Chromium may only write under ~/snap/chromium.
case "$BROWSER" in
  /snap/*) PROFILE_DIR="${HV_PROFILE_DIR:-$HOME/snap/chromium/common/hector-vector}" ;;
  *)       PROFILE_DIR="${HV_PROFILE_DIR:-$HOME/.local/share/hector-vector/profile}" ;;
esac
mkdir -p "$PROFILE_DIR"

exec "$BROWSER" \
  --app="$URL" \
  --user-data-dir="$PROFILE_DIR" \
  --class=hector-vector \
  --name=hector-vector \
  --ozone-platform-hint=auto \
  --enable-features=DesktopPWAsAdditionalWindowingControls \
  --window-size=1280,820 \
  "$@"

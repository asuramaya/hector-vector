#!/usr/bin/env bash
# One-shot installer for hector-vector.
#
# Creates a project-local .venv, installs the runtime deps (Pillow + numpy) into
# it, and verifies the install with the smoke test. The heavy external tools
# (Real-ESRGAN, VTracer, rembg) still bootstrap on demand at runtime — this just
# gets the server runnable. Idempotent: safe to re-run.
#
#   ./install.sh            # set up .venv + deps, run smoke test
#   ./install.sh --ai       # ...and install the optional AI deps now (rembg + vtracer)
#   ./install.sh --desktop  # also install the desktop launcher
#   ./install.sh --app      # ...and launch the app window when done
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

WANT_DESKTOP=0
WANT_APP=0
WANT_AI=0
for arg in "$@"; do
  case "$arg" in
    --ai)      WANT_AI=1 ;;
    --desktop) WANT_DESKTOP=1 ;;
    --app)     WANT_APP=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

# --- Python 3.10+ check ---
if ! command -v python3 >/dev/null 2>&1; then
  echo "install.sh: python3 not found. Install Python 3.10+ and re-run." >&2
  exit 1
fi
if ! python3 - <<'PY'
import sys
sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)
PY
then
  echo "install.sh: Python 3.10+ required (found $(python3 -V 2>&1))." >&2
  exit 1
fi

VENV=".venv"
PY="$VENV/bin/python3"

# --- venv + deps ---
if [ ! -x "$PY" ]; then
  echo "install.sh: creating $VENV"
  python3 -m venv "$VENV"
fi
# Some venvs are created without pip (e.g. distro 'python3-venv' missing, or a
# stale venv) — bootstrap it with ensurepip before installing anything.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "install.sh: bootstrapping pip in the venv"
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "install.sh: pip is unavailable in $VENV. Install your distro's python3-venv / python3-pip and re-run." >&2
  exit 1
fi
echo "install.sh: installing runtime dependencies"
"$PY" -m pip install --upgrade pip wheel >/dev/null
"$PY" -m pip install -r requirements.txt

# --- verify ---
echo "install.sh: verifying (smoke test)…"
if "$PY" tests/test_smoke.py; then
  echo "install.sh: smoke test passed."
else
  echo "install.sh: smoke test FAILED — see output above." >&2
  exit 1
fi

# --- optional AI deps (otherwise these bootstrap on first use / from Settings) ---
if [ "$WANT_AI" = "1" ]; then
  echo "install.sh: installing AI deps (rembg + onnxruntime + cairosvg, ~500MB)…"
  "$PY" -m pip install --upgrade 'rembg[cpu]' onnxruntime cairosvg
  if command -v cargo >/dev/null 2>&1; then
    echo "install.sh: building VTracer via cargo (this can take a few minutes)…"
    cargo install vtracer --root ./tools/cargo
  else
    echo "install.sh: cargo not found — skipping VTracer (install Rust, or it builds on first trace)." >&2
  fi
  echo "install.sh: Real-ESRGAN auto-downloads on first upscale (or from Settings → AI models)."
fi

# --- optional extras ---
if [ "$WANT_DESKTOP" = "1" ]; then
  ./install-desktop.sh
fi

echo
echo "✓ hector-vector is installed."
echo "  Start it:        ./run.sh        → http://localhost:2002"
echo "  App window:      ./launch.sh"
echo "  (run.sh auto-uses $VENV; heavy tools install on first use.)"

if [ "$WANT_APP" = "1" ]; then
  exec ./launch.sh
fi

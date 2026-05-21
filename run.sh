#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

port="${PORT:-2002}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "run.sh: invalid PORT='$port' (must be 1-65535)" >&2
  exit 2
fi

server_path="$(pwd)/server.py"

# If an old server.py is already bound to this port, replace it so re-runs are idempotent.
# Anything else on the port is left alone and reported as a conflict.
if command -v ss >/dev/null 2>&1; then
  pids="$(ss -ltnpH "sport = :$port" 2>/dev/null \
    | { grep -oE 'pid=[0-9]+' || true; } | cut -d= -f2 | sort -u)"
else
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
fi

for pid in $pids; do
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" == *"$server_path"* ]] || [[ "$cmdline" == *"server.py"* && -r "/proc/$pid/cwd" && "$(readlink -f /proc/$pid/cwd)" == "$(pwd)" ]]; then
    echo "run.sh: replacing existing server.py (pid $pid) on port $port" >&2
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "run.sh: port $port is held by pid $pid (${cmdline:-unknown}); refusing to kill" >&2
    exit 1
  fi
done

exec env PORT="$port" python3 server.py

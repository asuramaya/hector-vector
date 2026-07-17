#!/usr/bin/env bash
# Runs a command under a hard cgroup memory cap — built specifically for Playwright/headless-
# Chromium test runs (editor_e2e.py, tools/render_png.py, ad-hoc verify scripts), which have
# twice now grown a runaway renderer (one seen at 701% CPU / ~15GB RSS) that swaps the whole
# machine into unresponsiveness rather than just dying on its own. `ulimit` does not fix this:
# Chromium reserves huge virtual address space regardless of real usage, and rlimits are per-
# process anyway (a multi-process browser's zygote/renderer/gpu tree slips past a single-PID
# limit). A cgroup caps the whole tree together, including children reparented to init if the
# original parent dies first — which is exactly the shape of the leak this guards against.
#
# MemorySwapMax=0 is load-bearing, not just MemoryMax: without it, a process that hits the cap
# spills into swap instead of dying, and swapping is what actually thrashes the WHOLE system
# (other processes' pages get evicted too) — a clean, contained OOM-kill inside the cgroup is
# the fix, not a slow system-wide death. Verified 2026-07-16: a synthetic allocator hit MemoryMax
# and was SIGKILL'd (exit 137) at the cap, never touching swap.
#
# 8G, not the 4G first tried: a real editor_e2e.py run (Python + the Node.js Playwright driver +
# Chromium's own process tree, all inside the SAME cgroup) genuinely peaked at 4G and got
# OOM-killed mid-run on legitimate work, confirmed via `journalctl --user` ("4G memory peak...
# oom-kill"). 8G ran the full suite clean with room to spare. Still a hard ceiling nowhere near
# the 61G+8G-swap a real leak was free to consume before this existed.
#
# Usage: scripts/capped-run.sh [command args...]
#   CAPPED_MEM=6G scripts/capped-run.sh python -u tests/e2e/editor_e2e.py
set -euo pipefail

MEM="${CAPPED_MEM:-8G}"

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/capped-run.sh <command> [args...]" >&2
  exit 2
fi

exec systemd-run --user --scope --quiet \
  -p MemoryMax="$MEM" -p MemorySwapMax=0 \
  -- "$@"

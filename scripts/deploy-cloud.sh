#!/usr/bin/env bash
# Deploy the SERVERLESS (cloud) build to Cloudflare Pages → hector-vector.com.
#
# The app has no build step — this only SELECTS the runtime static files (and excludes the Python
# backend, tests, venvs, inputs/outputs) into dist/ and uploads them. Cloud mode engages
# automatically on the deployed host via the hostname detect in index.html (*.pages.dev + the
# custom domain). Re-run any time to redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root — this script lives in scripts/

DIST="dist"
rm -rf "$DIST"; mkdir -p "$DIST"
# web/ IS the deploy root: everything in it lands at the top of dist/, so the URLs the browser
# asks for are the same ones the local server answers. Keep it that way — _headers and robots.txt
# only work at the root, and sw.js must be at / or its scope shrinks to its own directory.
cp web/* "$DIST"/
cp -r assets src "$DIST"/
cp tests/companion-spike.html "$DIST"/companion-spike.html   # LNA bridge spike, run from the public origin
cp tests/pen-probe.html "$DIST"/pen-probe.html               # does this device's pen report pressure? (needed on the iPad, which can't reach localhost)

echo "── bundle ──"; find "$DIST" -type f | sed "s|^$DIST/|  |" | sort
echo "── deploying to Cloudflare Pages (project: hector-vector) ──"
npx wrangler pages deploy "$DIST" --project-name hector-vector --branch main --commit-dirty=true

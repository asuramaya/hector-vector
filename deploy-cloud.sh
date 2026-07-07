#!/usr/bin/env bash
# Deploy the SERVERLESS (cloud) build to Cloudflare Pages → hector-vector.com.
#
# The app has no build step — this only SELECTS the runtime static files (and excludes the Python
# backend, tests, venvs, inputs/outputs) into dist/ and uploads them. Cloud mode engages
# automatically on the deployed host via the hostname detect in index.html (*.pages.dev + the
# custom domain). Re-run any time to redeploy.
set -euo pipefail
cd "$(dirname "$0")"

DIST="dist"
rm -rf "$DIST"; mkdir -p "$DIST"
cp index.html style.css sw.js manifest.webmanifest _headers "$DIST"/
cp -r assets src "$DIST"/
cp tests/companion-spike.html "$DIST"/companion-spike.html   # LNA bridge spike, run from the public origin

echo "── bundle ──"; find "$DIST" -type f | sed "s|^$DIST/|  |" | sort
echo "── deploying to Cloudflare Pages (project: hector-vector) ──"
npx wrangler pages deploy "$DIST" --project-name hector-vector --branch main --commit-dirty=true

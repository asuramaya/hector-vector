#!/usr/bin/env bash
# Deploy the SERVERLESS (cloud) build to Cloudflare Pages — one project, three custom domains:
#   hector-vector.com / www.  -> the marketing landing page (web/index.html)
#   app.hector-vector.com     -> the editor itself (web/app.html)
# web/functions/_middleware.js does the host-based routing at the edge; app.html's own inline
# script (*.pages.dev + app.hector-vector.com) engages cloud mode (pipeline/library/batch gated
# behind a "download the desktop app" CTA) the same way it always has.
#
# The app has no build step — this only SELECTS the runtime static files (and excludes the Python
# backend, tests, venvs, inputs/outputs) into dist/ and uploads them. Re-run any time to redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root — this script lives in scripts/

DIST="dist"
rm -rf "$DIST"; mkdir -p "$DIST"
# web/ IS the deploy root: everything in it lands at the top of dist/, so the URLs the browser
# asks for are the same ones the local server answers. Keep it that way — _headers/_redirects and
# robots.txt only work at the root, sw.js must be at / or its scope shrinks to its own directory,
# and functions/_middleware.js (host-based routing between the landing page and the app — see that
# file) only runs from a top-level functions/ dir. `-r web/.` (not `web/*`) so it recurses into
# functions/ instead of erroring on it as a bare directory.
cp -r web/. "$DIST"/
cp -r assets src "$DIST"/
cp tests/companion-spike.html "$DIST"/companion-spike.html   # LNA bridge spike, run from the public origin
cp tests/pen-probe.html "$DIST"/pen-probe.html               # does this device's pen report pressure? (needed on the iPad, which can't reach localhost)

echo "── bundle ──"; find "$DIST" -type f | sed "s|^$DIST/|  |" | sort
echo "── deploying to Cloudflare Pages (project: hector-vector) ──"
# `cd` into dist/ and deploy "." rather than deploying "dist" from the repo root: wrangler looks
# for a functions/ dir relative to its OWN invocation cwd, not the deploy-target directory you
# pass it — invoked from the repo root, it never sees dist/functions/_middleware.js at all, and
# the deployment silently comes back `uses_functions: false` with no error. cd first, and it finds
# ./functions correctly (verified: `wrangler pages deployment <id>` in the Pages API flips to
# `uses_functions: true` and the host-based routing actually runs).
(cd "$DIST" && npx wrangler pages deploy . --project-name hector-vector --branch main --commit-dirty=true)

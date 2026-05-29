#!/usr/bin/env bash
# Cut a release: bump VERSION, commit, tag vX.Y.Z, and push.
# The `v*` tag push triggers .github/workflows/release.yml, which runs the smoke
# test and publishes a GitHub Release.
#
#   ./scripts/release.sh 1.1.0
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

VER="${1:-}"
if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 X.Y.Z   (semver, e.g. 1.1.0)" >&2
  exit 2
fi
TAG="v$VER"

# Refuse on a dirty tree or if the tag already exists.
if [ -n "$(git status --porcelain)" ]; then
  echo "release.sh: working tree is dirty — commit or stash first." >&2
  exit 1
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "release.sh: tag $TAG already exists." >&2
  exit 1
fi

echo "$VER" > VERSION
git add VERSION
git commit -m "Release $TAG"
git tag -a "$TAG" -m "hector-vector $TAG"
git push --follow-tags

echo "Pushed $TAG. The release workflow will publish the GitHub Release."

#!/usr/bin/env bash
# Install the spacehub client globally, the way gh is installed: puts
# `spacehub` and `git-remote-quirq` (plus git-remote-spacehub, for older
# clones) on your PATH. Needs Node 22+ and git.
#   scripts/install-cli.sh                 (npm's global prefix)
#   scripts/install-cli.sh --prefix ~/.local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT/cli"
npm install --no-audit --no-fund --silent
npm run build --silent
tarball="$(npm pack --silent --pack-destination "$TMP")"
npm install --global --no-audit --no-fund "$@" "$TMP/$tarball"

echo
echo "Installed: $(command -v spacehub || echo 'spacehub (add the npm global bin directory to PATH)')"
echo "Next: spacehub auth login --builder <name>   (server: wss://hub.quirq.dev; another with --server <url>)"

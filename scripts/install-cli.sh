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

# Where npm linked spacehub: <prefix>/bin, for --prefix <dir> or npm's own.
prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="${2:-}"; shift ;;
    --prefix=*) prefix="${1#--prefix=}" ;;
  esac
  shift
done
[ -n "$prefix" ] || prefix="$(npm prefix --global)"
bin="$(cd "$prefix/bin" 2>/dev/null && pwd || echo "$prefix/bin")"

shell="$(basename "${SHELL:-}")"
case "$shell" in
  zsh) rc='~/.zshrc' ;;
  bash) rc='~/.bashrc' ;;
  *) rc='~/.profile' ;;
esac

echo
found="$(command -v spacehub || true)"
if [ -n "$found" ] && [ "$found" -ef "$bin/spacehub" ]; then
  echo "Installed: $found"
else
  if [ -n "$found" ]; then
    echo "Installed spacehub in $bin, but your shell finds $found first."
  else
    echo "Installed spacehub in $bin, which is not on your PATH yet."
  fi
  echo "Put it on PATH for new shells and this one:"
  if [ "$shell" = fish ]; then
    echo "  fish_add_path $bin"
  else
    echo "  echo 'export PATH=\"$bin:\$PATH\"' >> $rc"
    echo "  export PATH=\"$bin:\$PATH\""
  fi
fi
case "$bin/" in
  "$HOME"/*) ;;
  *)
    echo
    echo "Note: $bin is outside your home folder. A workspace that resets on restart"
    echo "(as many cloud workspaces do outside home) loses it; to keep it, install with:"
    echo "  scripts/install-cli.sh --prefix ~/.local"
    ;;
esac
echo
echo "Next: spacehub auth login --builder <name>   (server: wss://hub.quirq.dev; another with --server <url>)"
echo "Check the setup any time: spacehub doctor"

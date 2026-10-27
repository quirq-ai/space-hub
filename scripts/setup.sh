#!/usr/bin/env bash
# Install, build and publish spacehub.
#   scripts/setup.sh              publish to the local server (spacetime start)
#   scripts/setup.sh maincloud    publish to SpacetimeDB Maincloud
# The database name defaults to "spacehub"; override with SPACEHUB_DB.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${1:-local}"
DB="${SPACEHUB_DB:-spacehub}"

(cd "$ROOT/module" && npm install --no-audit --no-fund --silent)
(cd "$ROOT/cli" && npm install --no-audit --no-fund --silent && npm run build --silent)
spacetime publish --server "$SERVER" "$DB" --module-path "$ROOT/module" --yes
# The identity that published is the hub's admin (as in the server image).
spacetime call --server "$SERVER" "$DB" claim_admin >/dev/null

cat <<MSG

spacehub is published as "$DB" on $SERVER.
Client: scripts/install-cli.sh (global, like gh), or for this shell only:
  export PATH="$ROOT/cli/bin:\$PATH"
Then: spacehub auth login --builder <name>
MSG
if [[ "$SERVER" != "local" ]]; then
  echo "(add --server <url> --db $DB to auth login for a non-local server)"
fi

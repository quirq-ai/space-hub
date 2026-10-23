#!/bin/sh
# Start SpacetimeDB on an internal port and the allowlist proxy on the
# public port, publish (or update) the spacehub module, then start the web
# service (sign in, sign up, GitHub import). The proxy comes up first so
# platform probes see an open port at once; /healthz only turns 200 once
# SpacetimeDB answers.
# Publishing never passes --delete-data: a breaking schema change makes
# startup fail instead of wiping spaces.
set -eu

ROOT="${SPACETIME_ROOT:-/data}"
DB="${SPACEHUB_DB:-spacehub}"
INTERNAL="127.0.0.1:${SPACETIME_INTERNAL_PORT:-3001}"
export PORT="${PORT:-3000}"

# Platform volumes usually arrive owned by root. Started as root, take the
# data directory for the spacetime user, then drop root for everything else.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$ROOT"
  if [ "$(stat -c %u "$ROOT")" != "$(id -u spacetime)" ]; then
    echo "spacehub: giving $ROOT to the spacetime user"
    chown -R spacetime:spacetime "$ROOT"
  fi
  export HOME=/home/spacetime
  exec setpriv --reuid=spacetime --regid=spacetime --init-groups /usr/local/bin/spacehub-server "$@"
fi
if [ ! -w "$ROOT" ]; then
  echo "spacehub: $ROOT is not writable by uid $(id -u). Mount writable storage there," >&2
  echo "spacehub: give the pod an fsGroup of 1000, or let the container start as root so it can fix ownership." >&2
  exit 1
fi

spacetime --root-dir "$ROOT" start --listen-addr "$INTERNAL" --non-interactive &
server=$!
caddy run --config /opt/spacehub/Caddyfile --adapter caddyfile &
proxy=$!
web=""
stop() {
  kill -TERM "$server" "$proxy" $web 2>/dev/null || true
  wait
}
trap 'stop; exit 0' TERM INT

tries=0
until curl -sf "http://$INTERNAL/v1/ping" >/dev/null 2>&1; do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "spacehub: SpacetimeDB exited during startup" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "spacehub: SpacetimeDB did not answer on $INTERNAL" >&2
    exit 1
  fi
  sleep 0.2
done

spacetime --root-dir "$ROOT" publish --server "http://$INTERNAL" "$DB" --js-path /opt/spacehub/module.js --yes
# Rebuild the activity feed's history once (later calls do nothing).
spacetime --root-dir "$ROOT" call --server "http://$INTERNAL" "$DB" backfill_activity >/dev/null 2>&1 \
  || echo "spacehub: could not rebuild the activity history; the feed starts from now" >&2

# The identity that owns the database is the hub's admin (it alone writes the
# xo tables and switches sign-up). Claim it on every start: the first claim
# sticks, and if another identity holds it, stop rather than serve.
if ! claim="$(spacetime --root-dir "$ROOT" call --server "http://$INTERNAL" "$DB" claim_admin 2>&1)"; then
  echo "spacehub: could not claim the hub admin: $claim" >&2
  echo "spacehub: refusing to start; if another identity holds it, the database was tampered with" >&2
  exit 1
fi

# xo.quirq.dev's API (/-/api/xo/v1/) is on only with SPACEHUB_XO_KEY. It acts
# as the admin, and agents then come from xo only.
if [ -n "${SPACEHUB_XO_KEY:-}" ]; then
  SPACEHUB_ADMIN_TOKEN="$( { spacetime --root-dir "$ROOT" login show --token 2>/dev/null; cat "$ROOT/config/cli.toml" 2>/dev/null; } \
    | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -n 1)"
  if [ -z "$SPACEHUB_ADMIN_TOKEN" ]; then
    echo "spacehub: SPACEHUB_XO_KEY is set but the admin's token could not be read" >&2
    exit 1
  fi
  export SPACEHUB_ADMIN_TOKEN
  spacetime --root-dir "$ROOT" call --server "http://$INTERNAL" "$DB" set_accounts '"xo"' >/dev/null
fi

SPACEHUB_SERVER="ws://$INTERNAL" SPACEHUB_INTERNAL_HTTP="http://$INTERNAL" SPACEHUB_DB="$DB" node /opt/spacehub/cli/dist/web.mjs &
web=$!
echo "spacehub: serving database \"$DB\" on port $PORT"

while kill -0 "$server" 2>/dev/null && kill -0 "$proxy" 2>/dev/null && kill -0 "$web" 2>/dev/null; do
  sleep 2
done
echo "spacehub: a server process exited; stopping" >&2
stop
exit 1

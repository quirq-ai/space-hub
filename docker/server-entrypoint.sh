#!/bin/sh
# Start SpacetimeDB on an internal port, publish (or update) the spacehub
# module, then open the public port through the allowlist proxy.
# Publishing never passes --delete-data: a breaking schema change makes
# startup fail instead of wiping spaces.
set -eu

ROOT="${SPACETIME_ROOT:-/data}"
DB="${SPACEHUB_DB:-spacehub}"
INTERNAL="127.0.0.1:${SPACETIME_INTERNAL_PORT:-3001}"
export PORT="${PORT:-3000}"

spacetime --root-dir "$ROOT" start --listen-addr "$INTERNAL" --non-interactive &
server=$!
proxy=""
stop() {
  kill -TERM "$server" $proxy 2>/dev/null || true
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

caddy run --config /opt/spacehub/Caddyfile --adapter caddyfile &
proxy=$!
echo "spacehub: serving database \"$DB\" on port $PORT"

while kill -0 "$server" 2>/dev/null && kill -0 "$proxy" 2>/dev/null; do
  sleep 2
done
echo "spacehub: a server process exited; stopping" >&2
stop
exit 1

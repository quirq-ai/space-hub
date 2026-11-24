#!/usr/bin/env bash
# Private projects end to end: starts a throwaway SpacetimeDB, publishes the
# module, and drives the spacehub CLI, real git and the module's data route
# (as the web service asks it, with the viewer and the start's secret):
#   a public project: another builder clones it and reads its page;
#   made private (only by an owner of its space): that builder's clone is
#   refused, the project is "not found" and its page is a 404, as if missing,
#   while the owner sees no change and the feed says what happened;
#   made public again: access comes back.
#   scripts/private-e2e.sh            (needs: spacetime, git, node 22+, curl)
#   PORT=4071 scripts/private-e2e.sh  another port
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3199}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/spacehub-private.XXXXXX")"
SERVER_PID=""
PASS=0
# Stops the server; the work files (logs, clones) stay in $WORK for a look afterwards.
trap 'set +e; [[ -n "$SERVER_PID" ]] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }; echo "work files: $WORK"' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok  %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
as() { local who="$1"; shift; SPACEHUB_HOME="$WORK/home-$who" "$@"; }
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label"; fi; }
refused() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$label (it worked)"; else ok "$label"; fi; }
has() { # has <label> <text> <cmd...>: the command succeeds and says text
  local label="$1" text="$2" out; shift 2
  out="$("$@" 2>&1)" || { echo "$out" >&2; fail "$label (failed)"; }
  grep -qF -- "$text" <<<"$out" || { echo "$out" >&2; fail "$label (no \"$text\")"; }
  ok "$label"
}
says() { # says <label> <text> <cmd...>: whatever the exit, the output says text
  local label="$1" text="$2" out; shift 2
  out="$("$@" 2>&1)" || true
  grep -qF -- "$text" <<<"$out" || { echo "$out" >&2; fail "$label (no \"$text\")"; }
  ok "$label"
}

echo "building the CLI"
(cd "$ROOT/cli" && npm run build --silent >/dev/null 2>&1) || fail "build the CLI"
export PATH="$ROOT/cli/bin:$PATH"
export SPACEHUB_SERVER="ws://127.0.0.1:$PORT" SPACEHUB_DB="spacehub-private"
HTTP="http://127.0.0.1:$PORT"
if curl -sf "$HTTP/v1/ping" >/dev/null 2>&1; then fail "port $PORT is in use; set PORT"; fi
spacetime start --in-memory --data-dir "$WORK/stdb" --listen-addr "127.0.0.1:$PORT" --non-interactive >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "$HTTP/v1/ping" >/dev/null 2>&1 && break; sleep 0.2; done
spacetime publish --server "$HTTP" "$SPACEHUB_DB" --module-path "$ROOT/module" --yes >"$WORK/publish.log" 2>&1 || { cat "$WORK/publish.log" >&2; fail "publish"; }
admin_call() { spacetime call --server "$HTTP" "$SPACEHUB_DB" "$@" >/dev/null 2>&1; }
admin_call claim_admin || fail "claim admin"
# The web service's secret: with it, the module's pages and data are asked as a named viewer.
SECRET="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
admin_call set_web_secret "\"$SECRET\"" || fail "set the web secret"
ok "module published"

RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
ALICE="alice$RUN"; BOB="bob$RUN"; P="$ALICE/notes"
# The project's data as the web service asks for it (cli/src/app.ts /-/api/view): its HTTP status.
page() { # page <viewer or ""> <query>
  curl -s -o "$WORK/page.json" -w '%{http_code}' -H "x-spacehub-secret: $SECRET" -H "x-spacehub-viewer: $1" "$HTTP/v1/database/$SPACEHUB_DB/route/api?$2"
}
clone() { # clone <who> <dir>
  as "$1" git clone -q "quirq://127.0.0.1:$PORT/$P" "$WORK/$2"
}

echo "a public project"
check "two builders" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub auth login --builder $ALICE && SPACEHUB_HOME='$WORK/home-bob' spacehub auth login --builder $BOB"
has "create --public says so" "Created project $P (public)" as alice spacehub project create notes --public
git init -q -b main "$WORK/src"
(cd "$WORK/src" && echo hello >a.txt && git add . && git -c user.name=t -c user.email=t@e commit -qm first \
  && SPACEHUB_HOME="$WORK/home-alice" git push -q "quirq://127.0.0.1:$PORT/$P" main 2>/dev/null) || fail "push"
ok "pushed a commit"
check "another builder clones it" clone bob c1
has "and lists it as public" "public" as bob spacehub project list "$ALICE"
[[ "$(page "$BOB" "space=$ALICE&project=notes")" == 200 ]] && ok "and reads its page" || fail "and reads its page"
grep -q '"visibility":"public"' "$WORK/page.json" && ok "which says public" || fail "which says public"
grep -q '"canSetVisibility":false' "$WORK/page.json" && ok "and that bob may not change it" || fail "bob may not change it"

echo "made private"
says "only an owner of its space may make it private" "permission denied" as bob spacehub project visibility "$P" private
has "its owner makes it private" "$P is now private" as alice spacehub project visibility "$P" private
has "project view says so" "visible   private" as alice spacehub project view "$P"
has "--private and --public together are refused" "not both" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project create other --private --public 2>&1; true"
refused "the other builder's clone is refused" clone bob c2
says "for them it is not found" "not found" as bob spacehub project view "$P"
if as bob spacehub project list "$ALICE" 2>&1 | grep -qF "$P"; then fail "nor listed"; else ok "nor listed"; fi
[[ "$(page "$BOB" "space=$ALICE&project=notes")" == 404 ]] && ok "its page is a 404 for them" || fail "its page is a 404 for them"
[[ "$(page "" "space=$ALICE&project=notes")" == 404 ]] && ok "and signed out" || fail "and signed out"
[[ "$(page "$BOB" "space=$ALICE&project=nosuch")" == 404 ]] && ok "as for a project that does not exist" || fail "as for a missing project"
[[ "$(page "$ALICE" "space=$ALICE&project=notes")" == 200 ]] && ok "its owner reads it as before" || fail "its owner reads it"
grep -q '"visibility":"private"' "$WORK/page.json" && ok "marked private" || fail "marked private"
grep -q '"canSetVisibility":true' "$WORK/page.json" && ok "and changeable by its owner" || fail "changeable by its owner"
grep -q '"kind":"visibility_changed"' "$WORK/page.json" && ok "the change is in its activity" || fail "the change is in its activity"
[[ "$(page "$ALICE" "space=$ALICE")" == 200 ]] && grep -q '"private":true' "$WORK/page.json" && ok "its space lists it with a lock for its owner" || fail "space listing"
check "its owner still clones it" clone alice c3

echo "made public again"
has "its owner makes it public" "$P is now public" as alice spacehub project visibility "$P" public
check "the other builder clones it again" clone bob c4
[[ "$(page "$BOB" "space=$ALICE&project=notes")" == 200 ]] && ok "and reads its page again" || fail "and reads its page again"
has "create --private makes a private one" "Created project $ALICE/hidden (private)" as alice spacehub project create hidden --private
[[ "$(page "$BOB" "space=$ALICE&project=hidden")" == 404 ]] && ok "which the other builder cannot read" || fail "which the other builder cannot read"

echo "all $PASS checks passed"

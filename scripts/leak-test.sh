#!/usr/bin/env bash
# Members-only leak test: starts a throwaway SpacetimeDB, publishes the
# module, fills it a little through the CLI (a builder, a project, a push),
# then asks as a stranger (a new anonymous identity, no website, the raw
# SpacetimeDB protocol): every visible_* view by subscription, every table by
# subscription and by SQL.
#   members-only off: the stranger sees exactly what the admin sees (today)
#   members-only on:  the stranger sees nothing; a builder still sees everything
# Then a private project: a member without access (and a stranger) gets none
# of its rows from any view, its owner and the admin get all of them, a
# collaborator loses them live when removed, and they come back live when it
# is made public; git clone works only for those who may read it.
# Then the same over every web route, through the server image's Caddyfile
# and the web service (scripts/routeprobe.ts, routes listed in scripts/routes.ts):
# an anonymous browser and a signed-in stranger get only sign-in, a member
# sees no change, and off is today.
#   scripts/leak-test.sh                  (needs: spacetime, git, node 22+, python3,
#                                          caddy, or docker to copy it from caddy:$CADDY_VERSION)
#   OLD_CLI=<old spacehub> scripts/leak-test.sh   also checks an old CLI gets the update message
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3198}"
WEB_PORT="${WEB_PORT:-3196}"
FRONT_PORT="${FRONT_PORT:-3197}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/spacehub-leak.XXXXXX")"
PIDS=()
trap 'set +e; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done; rm -rf "$WORK"' EXIT

ok() { printf '  ok  %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
as() { local who="$1"; shift; SPACEHUB_HOME="$WORK/home-$who" "$@"; }

(cd "$ROOT/cli" && npm run build --silent >/dev/null 2>&1) || fail "build the CLI"
(cd "$ROOT/cli" && npx esbuild "$ROOT/scripts/leakprobe.ts" --bundle --platform=node --format=esm --target=node22 \
  --outfile="$WORK/probe.mjs" --log-level=warning) || fail "build the probe"
export PATH="$ROOT/cli/bin:$PATH"
export SPACEHUB_SERVER="ws://127.0.0.1:$PORT" SPACEHUB_DB="spacehub-leak"
HTTP="http://127.0.0.1:$PORT"

if curl -sf "$HTTP/v1/ping" >/dev/null 2>&1; then fail "port $PORT is in use; set PORT"; fi
spacetime start --in-memory --data-dir "$WORK/stdb" --listen-addr "127.0.0.1:$PORT" --non-interactive >"$WORK/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do curl -sf "$HTTP/v1/ping" >/dev/null 2>&1 && break; sleep 0.2; done
spacetime publish --server "$HTTP" "$SPACEHUB_DB" --module-path "$ROOT/module" --yes >"$WORK/publish.log" 2>&1 || { cat "$WORK/publish.log" >&2; fail "publish"; }
spacetime call --server "$HTTP" "$SPACEHUB_DB" claim_admin >/dev/null 2>&1 || fail "claim admin"
ADMIN_TOKEN="$(spacetime login show --token 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -n 1)"
members_only() { spacetime call --server "$HTTP" "$SPACEHUB_DB" set_members_only "$1" >/dev/null 2>&1 || fail "set_members_only $1"; }

echo "a hub with some data"
as alice spacehub auth login --builder alice >/dev/null
as alice spacehub project create leakproj -d "leakdesc of a leak test" >/dev/null
git init -q -b main "$WORK/a"
(cd "$WORK/a" && echo leakcontent >a.txt && git add . && git -c user.name=t -c user.email=t@e commit -qm first \
  && SPACEHUB_HOME="$WORK/home-alice" git push -q "quirq://127.0.0.1:$PORT/alice/leakproj" main 2>/dev/null) || fail "push"
as alice spacehub space create acme >/dev/null 2>&1 || true
ALICE_TOKEN="$(as alice spacehub auth token)"
ok "builder, project, push"

probe() { node "$WORK/probe.mjs" "$SPACEHUB_SERVER" "$SPACEHUB_DB" "$@" 2>>"$WORK/probe.err"; }
probe "$ADMIN_TOKEN" --no-raw >"$WORK/admin.json"
probe >"$WORK/off.json"
members_only true
probe >"$WORK/on.json"
probe "$ALICE_TOKEN" >"$WORK/member.json"
# A stranger already subscribed when the owner switches it on.
members_only false
LEAK_SIGNAL="$WORK/toggled" probe --watch-toggle >"$WORK/watch.json" &
WATCH=$!
for _ in $(seq 1 50); do [[ -s "$WORK/watch.json" ]] && break; sleep 0.2; done
members_only true
touch "$WORK/toggled"
wait "$WATCH"
members_only false
probe >"$WORK/off-again.json"

python3 - "$WORK" <<'PY' || { tail -20 "$WORK/probe.err" >&2; exit 1; }
import json, sys
w = sys.argv[1]
load = lambda n: json.loads(open(f"{w}/{n}.json").read().splitlines()[0])
admin, off, on, member, again = (load(n) for n in ("admin", "off", "on", "member", "off-again"))
watch = [json.loads(l) for l in open(f"{w}/watch.json").read().splitlines()]
truth = {k: v for k, v in admin["sql"].items() if isinstance(v, int)}
view_table = lambda v: v[len("visible"):][0].lower() + "".join("_" + c.lower() if c.isupper() else c for c in v[len("visible") + 1:])
bad = []
def check(label, cond):
    print(("  ok  " if cond else "  FAIL ") + label)
    if not cond: bad.append(label)
def views_are(label, got, want):
    diff = {v: (n, want(v)) for v, n in got["subscribed"].items() if n != want(v)}
    check(f"{label}" + (f" (differs: {diff})" if diff else ""), not diff)
def tables_closed(label, got):
    raw = {t: r for t, r in got["rawTableSubscriptions"].items() if r != "refused"}
    sql = {t: n for t, n in got["sql"].items() if not t.startswith("visible_") and n != 0 and not str(n).startswith("refused")}
    check(f"{label}" + (f" (open: {raw} {sql})" if raw or sql else ""), not raw and not sql)

print("rows the admin sees:", {t: n for t, n in truth.items() if n})
views_are("off: a stranger's views hold every row (today's data)", off, lambda v: truth[view_table(v)])
tables_closed("off: no table is readable directly", off)
views_are("on: a stranger's views are empty", on, lambda v: 0)
check("on: a stranger's SQL over the views returns nothing", all(n == 0 for t, n in on["sql"].items() if t.startswith("visible_")))
tables_closed("on: no table is readable directly", on)
views_are("on: a builder still sees everything", member, lambda v: truth[view_table(v)])
check("on, while subscribed: the stranger's rows go away", len(watch) == 2 and all(n == 0 for n in watch[1]["afterToggle"].values()))
views_are("off again: exactly today's data", again, lambda v: truth[view_table(v)])
check("the data is not empty (the test means something)", sum(truth.get(t, 0) for t in ("project", "git_object", "git_ref", "user", "space")) >= 5)
sys.exit(1 if bad else 0)
PY

echo "a private project"
# A reducer called as a builder, over HTTP: call_as <token> <reducer> <json args>.
call_as() { curl -sf -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' --data "$3" \
  "$HTTP/v1/database/$SPACEHUB_DB/call/$2" >/dev/null || fail "$2 $3"; }
as alice spacehub project create hidden -d "hiddendesc of a private project" >/dev/null
git init -q -b main "$WORK/h"
(cd "$WORK/h" && echo hiddencontent >h.txt && git add . && git -c user.name=t -c user.email=t@e commit -qm hiddencommit \
  && SPACEHUB_HOME="$WORK/home-alice" git push -q "quirq://127.0.0.1:$PORT/alice/hidden" main 2>/dev/null) || fail "push hidden"
as bob spacehub auth login --builder bob >/dev/null
BOB_TOKEN="$(as bob spacehub auth token)"
call_as "$ALICE_TOKEN" set_project_visibility '["alice/hidden", "private"]'
# Still pushable by its owner once private.
(cd "$WORK/h" && echo more >>h.txt && git -c user.name=t -c user.email=t@e commit -qam hiddenmore \
  && SPACEHUB_HOME="$WORK/home-alice" git push -q "quirq://127.0.0.1:$PORT/alice/hidden" main 2>/dev/null) || fail "push to a private project"
ok "alice/hidden is private, with two pushes"
export LEAK_FIND="hidden,hiddencontent"
clones() { # clones <who> <dir>: whether <who> can clone alice/hidden
  SPACEHUB_HOME="$WORK/home-$1" timeout 60 git clone -q "quirq://127.0.0.1:$PORT/alice/hidden" "$2" >/dev/null 2>&1 && grep -q hiddencontent "$2/h.txt"
}
clones alice "$WORK/c-alice" && ok "its owner clones it" || fail "its owner clones it"
clones bob "$WORK/c-bob" && fail "a member without access clones it" || ok "a member without access cannot clone it"
probe "$ADMIN_TOKEN" --no-raw >"$WORK/p-admin.json"
probe "$ALICE_TOKEN" --no-raw >"$WORK/p-alice.json"
probe "$BOB_TOKEN" --no-raw >"$WORK/p-bob.json"
probe --no-raw >"$WORK/p-stranger.json"
members_only true
probe "$BOB_TOKEN" --no-raw >"$WORK/p-bob-on.json"
probe "$ALICE_TOKEN" --no-raw >"$WORK/p-alice-on.json"
members_only false
# bob as a collaborator: reads it and clones it; then removed while subscribed.
call_as "$ALICE_TOKEN" add_project_member '["alice/hidden", "bob"]'
clones bob "$WORK/c-bob2" && ok "a collaborator clones it" || fail "a collaborator clones it"
probe "$ADMIN_TOKEN" --no-raw >"$WORK/p-admin-collab.json"
LEAK_SIGNAL="$WORK/removed" probe "$BOB_TOKEN" --no-raw --watch-toggle >"$WORK/p-bob-removed.json" &
WATCH=$!
for _ in $(seq 1 50); do [[ -s "$WORK/p-bob-removed.json" ]] && break; sleep 0.2; done
call_as "$ALICE_TOKEN" remove_project_member '["alice/hidden", "bob"]'
touch "$WORK/removed"
wait "$WATCH"
# Made public while bob is subscribed: it comes back.
LEAK_SIGNAL="$WORK/public" probe "$BOB_TOKEN" --no-raw --watch-toggle >"$WORK/p-bob-public.json" &
WATCH=$!
for _ in $(seq 1 50); do [[ -s "$WORK/p-bob-public.json" ]] && break; sleep 0.2; done
call_as "$ALICE_TOKEN" set_project_visibility '["alice/hidden", "public"]'
touch "$WORK/public"
wait "$WATCH"
probe "$ADMIN_TOKEN" --no-raw >"$WORK/p-admin-public.json"
clones bob "$WORK/c-bob3" && ok "anyone clones it once public" || fail "anyone clones it once public"
call_as "$ALICE_TOKEN" set_project_visibility '["alice/hidden", "private"]' # for the web routes below

python3 - "$WORK" <<'PY' || { tail -20 "$WORK/probe.err" >&2; exit 1; }
import json, sys
w = sys.argv[1]
lines = lambda n: [json.loads(l) for l in open(f"{w}/{n}.json").read().splitlines()]
load = lambda n: lines(n)[0]
admin, alice, bob, stranger, bob_on, alice_on, admin_collab, admin_public = (load(n) for n in (
    "p-admin", "p-alice", "p-bob", "p-stranger", "p-bob-on", "p-alice-on", "p-admin-collab", "p-admin-public"))
removed, public = lines("p-bob-removed"), lines("p-bob-public")
hid = admin["projects"]["alice/hidden"]
of = lambda snap, p: {v: rows.get(p, 0) for v, rows in snap["byProject"].items() if rows.get(p, 0)}
others = lambda snap: {v: {p: n for p, n in rows.items() if p != hid} for v, rows in snap["byProject"].items()}
bad = []
def check(label, cond, detail=""):
    print(("  ok  " if cond else "  FAIL ") + label + ("" if cond else f" ({detail})"))
    if not cond: bad.append(label)
truth = of(admin, hid)
print("rows of alice/hidden the admin sees:", truth)
check("the private project has rows in the content views (the test means something)",
      all(truth.get(v, 0) > 0 for v in ("visibleProject", "visibleGitRef", "visibleGitObject", "visibleActivity", "visibleProjectSize")), truth)
check("its owner gets every row of it", of(alice, hid) == truth, of(alice, hid))
for label, snap in (("a member without access", bob), ("a stranger", stranger), ("a member without access, members-only on", bob_on)):
    check(f"{label} gets no row of it from any view", of(snap, hid) == {}, of(snap, hid))
    check(f"{label}: no view holds its name or contents", snap["found"] == {}, snap["found"])
check("a member without access still gets every other project, and rows about no project", others(bob) == others(admin),
      {v: (others(bob)[v], others(admin)[v]) for v in others(admin) if others(bob).get(v) != others(admin)[v]})
check("its owner, members-only on: every row of it", of(alice_on, hid) == truth, of(alice_on, hid))
check("a collaborator gets every row of it", of(removed[0], hid) == of(admin_collab, hid), (of(removed[0], hid), of(admin_collab, hid)))
check("removed while subscribed: its rows go away", len(removed) == 2 and of(removed[1]["after"], hid) == {} and removed[1]["after"]["found"] == {},
      removed[-1].get("after", {}).get("found"))
check("made public while subscribed: its rows come back", len(public) == 2 and of(public[0], hid) == {}
      and of(public[1]["after"], hid) == of(admin_public, hid), (of(public[-1].get("after", public[0]), hid), of(admin_public, hid)))
sys.exit(1 if bad else 0)
PY

echo "every web route, through the front door"
CADDY="${CADDY:-$(command -v caddy || true)}"
if [[ -z "$CADDY" ]]; then
  # The server image's own Caddy (Dockerfile CADDY_VERSION).
  version="$(sed -n 's/^ARG CADDY_VERSION=//p' "$ROOT/Dockerfile")"
  docker run --rm --entrypoint cat "caddy:$version" /usr/bin/caddy >"$WORK/caddy" 2>"$WORK/caddy.err" || { cat "$WORK/caddy.err" >&2; fail "no caddy: install it, set CADDY, or have docker"; }
  chmod +x "$WORK/caddy"
  CADDY="$WORK/caddy"
fi
for p in "$WEB_PORT" "$FRONT_PORT"; do curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null && fail "port $p is in use; set WEB_PORT / FRONT_PORT"; done
APP_DIR="$ROOT/app/dist"
[[ -f "$APP_DIR/index.html" ]] || (cd "$ROOT/app" && npm run build --silent >/dev/null 2>&1) || true
SPACEHUB_HOME="$WORK/home-web" SPACEHUB_WEB_PORT="$WEB_PORT" SPACEHUB_INTERNAL_HTTP="$HTTP" SPACEHUB_ADMIN_TOKEN="$ADMIN_TOKEN" \
  SPACEHUB_APP_DIR="$APP_DIR" SPACEHUB_GITHUB_API="http://127.0.0.1:9" SPACEHUB_ACTIVITY_DIR=off \
  SPACEHUB_RECOVERY_STATE_DIR="$WORK/recovery" node "$ROOT/cli/dist/web.mjs" >"$WORK/web.log" 2>&1 &
PIDS+=($!)
# (SPACETIME_INTERNAL_PORT before PORT: an assignment here sees the ones before it.)
XDG_DATA_HOME="$WORK/caddy-data" XDG_CONFIG_HOME="$WORK/caddy-config" SPACETIME_INTERNAL_PORT="$PORT" PORT="$FRONT_PORT" \
  SPACEHUB_WEB_PORT="$WEB_PORT" "$CADDY" run --config "$ROOT/docker/server.Caddyfile" --adapter caddyfile >"$WORK/caddy.log" 2>&1 &
PIDS+=($!)
FRONT="http://127.0.0.1:$FRONT_PORT"
for _ in $(seq 1 50); do curl -sf "$FRONT/-/login" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$FRONT/healthz" >/dev/null || { tail -5 "$WORK/caddy.log" "$WORK/web.log" >&2; fail "the front door did not start"; }
# A signed-in stranger: a valid identity with no builder.
STRANGER_TOKEN="$(curl -sf -X POST "$HTTP/v1/identity" | grep -oE '"token":"[^"]+"' | cut -d'"' -f4)"
[[ -n "$STRANGER_TOKEN" ]] || fail "a stranger's identity"
export LEAK_MARKERS="leakproj,leakdesc,leakcontent,alice" LEAK_COMMIT="$(git -C "$WORK/a" rev-parse HEAD)" STRANGER_TOKEN MEMBER_TOKEN="$ALICE_TOKEN"
routes() { node --experimental-strip-types --no-warnings "$ROOT/scripts/routeprobe.ts" "$FRONT" "$@" || { tail -5 "$WORK/web.log" >&2; exit 1; }; }
# The front door reads the flag at most every 5 seconds.
settle() { sleep 6; }
routes off "$WORK/routes-off.json"
members_only true; settle
routes on "$WORK/routes-on.json" "$WORK/routes-off.json"
# The front door passes a form's body on: a new builder signs up through it, members-only on.
curl -s -X POST -H "origin: $FRONT" -H 'accept: text/html' --data 'username=carol' "$FRONT/-/signup" | grep -q 'Welcome, <b>carol</b>' \
  && ok "on: sign-up through the front door (a form body passes)" || fail "on: sign-up through the front door"
members_only false; settle
routes off "$WORK/routes-off-again.json"

if [[ -n "${OLD_CLI:-}" ]]; then
  out="$(SPACEHUB_HOME="$WORK/home-alice" "$OLD_CLI" project list alice 2>&1 || true)"
  grep -q "out of date" <<<"$out" && ok "an old CLI is told to update" || { echo "$out" >&2; fail "old CLI message"; }
fi
echo "leak test passed"

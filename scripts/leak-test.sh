#!/usr/bin/env bash
# Members-only leak test: starts a throwaway SpacetimeDB, publishes the
# module, fills it a little through the CLI (a builder, a project, a push),
# then asks as a stranger (a new anonymous identity, no website, the raw
# SpacetimeDB protocol): every visible_* view by subscription, every table by
# subscription and by SQL.
#   members-only off: the stranger sees exactly what the admin sees (today)
#   members-only on:  the stranger sees nothing; a builder still sees everything
#   scripts/leak-test.sh                  (needs: spacetime, git, node 22+, python3)
#   OLD_CLI=<old spacehub> scripts/leak-test.sh   also checks an old CLI gets the update message
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3198}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/spacehub-leak.XXXXXX")"
SERVER_PID=""
trap 'set +e; [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

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
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "$HTTP/v1/ping" >/dev/null 2>&1 && break; sleep 0.2; done
spacetime publish --server "$HTTP" "$SPACEHUB_DB" --module-path "$ROOT/module" --yes >"$WORK/publish.log" 2>&1 || { cat "$WORK/publish.log" >&2; fail "publish"; }
spacetime call --server "$HTTP" "$SPACEHUB_DB" claim_admin >/dev/null 2>&1 || fail "claim admin"
ADMIN_TOKEN="$(spacetime login show --token 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -n 1)"
members_only() { spacetime call --server "$HTTP" "$SPACEHUB_DB" set_members_only "$1" >/dev/null 2>&1 || fail "set_members_only $1"; }

echo "a hub with some data"
as alice spacehub auth login --builder alice >/dev/null
as alice spacehub project create notes -d "leak test" >/dev/null
git init -q -b main "$WORK/a"
(cd "$WORK/a" && echo hello >a.txt && git add . && git -c user.name=t -c user.email=t@e commit -qm first \
  && SPACEHUB_HOME="$WORK/home-alice" git push -q "quirq://127.0.0.1:$PORT/alice/notes" main 2>/dev/null) || fail "push"
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

if [[ -n "${OLD_CLI:-}" ]]; then
  out="$(SPACEHUB_HOME="$WORK/home-alice" "$OLD_CLI" project list alice 2>&1 || true)"
  grep -q "out of date" <<<"$out" && ok "an old CLI is told to update" || { echo "$out" >&2; fail "old CLI message"; }
fi
echo "leak test passed"

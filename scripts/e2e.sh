#!/usr/bin/env bash
# End-to-end test: starts a throwaway SpacetimeDB on a spare port, publishes
# the module, then drives the spacehub CLI and real git through
# git-remote-quirq (and git-remote-spacehub for old spacehub:// URLs).
#   scripts/e2e.sh                                   (needs: spacetime, git, node 22+, python3)
#   SPACEHUB_E2E_SERVER=ws://127.0.0.1:3000 scripts/e2e.sh
#                                                    against a running server, e.g. the Docker image
#                                                    (database from SPACEHUB_E2E_DB, default spacehub)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3197}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/spacehub-e2e.XXXXXX")"
SERVER_PID=""
WEB_PID=""
BG=""  # watchers, autosyncs and streams started along the way
PASS=0

cleanup() {
  local status=$?
  # Best effort from here: a kill or wait "failing" must not change the result.
  set +e
  for pid in $BG; do kill "$pid" 2>/dev/null; done
  if [[ -n "$WEB_PID" ]]; then kill "$WEB_PID" 2>/dev/null; wait "$WEB_PID" 2>/dev/null; fi
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  ok  %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
expect_fail() { # expect_fail <label> <grep pattern> <cmd...>
  local label="$1" pattern="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then fail "$label (command succeeded)"; fi
  grep -q -- "$pattern" <<<"$out" || { echo "$out" >&2; fail "$label (no \"$pattern\")"; }
  ok "$label"
}
check() { # check <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label"; fi
}
same() { # same <label> <a> <b>
  if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1 ($2 != $3)"; fi
}
commit() { git -c user.name=e2e -c user.email=e2e@example.com commit -q "$@"; }
wait_for() { # wait_for <seconds> <cmd...>: until the command succeeds
  local tries=$(($1 * 5)); shift
  for _ in $(seq 1 "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  return 1
}
as() { # as <user> <cmd...>: run with that user's spacehub identity
  local who="$1"; shift
  SPACEHUB_HOME="$WORK/home-$who" "$@"
}

echo "building the client"
(cd "$ROOT/cli" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 && npm run build --silent >/dev/null 2>&1)
export PATH="$ROOT/cli/bin:$PATH"

if [[ -n "${SPACEHUB_E2E_SERVER:-}" ]]; then
  export SPACEHUB_SERVER="$SPACEHUB_E2E_SERVER"
  export SPACEHUB_DB="${SPACEHUB_E2E_DB:-spacehub}"
  echo "using $SPACEHUB_SERVER (database $SPACEHUB_DB)"
else
  export SPACEHUB_SERVER="ws://127.0.0.1:$PORT"
  export SPACEHUB_DB="spacehub-e2e"
  echo "starting SpacetimeDB on :$PORT"
  (cd "$ROOT/module" && npm install --silent --no-audit --no-fund >/dev/null 2>&1)
  spacetime start --in-memory --data-dir "$WORK/stdb" --listen-addr "127.0.0.1:$PORT" --non-interactive >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/v1/ping" >/dev/null 2>&1 && break
    sleep 0.2
  done
  spacetime publish --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" --module-path "$ROOT/module" --yes >"$WORK/publish.log" 2>&1 \
    || { cat "$WORK/publish.log" >&2; fail "publish module"; }
  spacetime call --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" backfill_activity >/dev/null 2>&1 || fail "backfill activity"
  spacetime call --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" migrate_spaces >/dev/null 2>&1 || fail "migrate spaces"
  # This CLI's identity published the module, so it is the hub's admin (as
  # in the server image), and the web service syncs GitHub links with its token.
  spacetime call --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" claim_admin >/dev/null 2>&1 || fail "claim admin"
  ADMIN_TOKEN="$(spacetime login show --token 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -n 1)"
  ok "module published"
fi

# The web UI: through the server image's proxy it lives at the root; on a
# bare SpacetimeDB it is the module's route, with the page path in ?p=.
ui() { # ui <path>[?query] -> URL
  local page="${1%%\?*}" query=""
  [[ "$1" == *\?* ]] && query="${1#*\?}"
  if [[ -n "${SPACEHUB_E2E_SERVER:-}" ]]; then
    local base="${SPACEHUB_SERVER/#ws/http}"
    printf '%s/%s%s' "$base" "$page" "${query:+?$query}"
  else
    printf 'http://127.0.0.1:%s/v1/database/%s/route/ui?p=%s%s' "$PORT" "$SPACEHUB_DB" "$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$page")" "${query:+&$query}"
  fi
}
page_has() { # page_has <label> <path> <text>
  local body
  body="$(curl -sf "$(ui "$2")")" || fail "$1 (HTTP error)"
  grep -qF -- "$3" <<<"$body" && ok "$1" || fail "$1 (no \"$3\")"
}
status_is() { # status_is <label> <path> <code>
  same "$1" "$(curl -s -o /dev/null -w '%{http_code}' "$(ui "$2")")" "$3"
}

# Unique names so the suite can run repeatedly against a long-lived server.
RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
ALICE="alice$RUN"; BOB="bob$RUN"; NOTES="$ALICE/notes"

echo "auth"
check "auth login registers the builder" as alice spacehub auth login --builder "$ALICE"
check "a second builder (--username and --agent still work)" as bob spacehub auth login --username "$BOB"
expect_fail "builder names are unique" "taken" as carol spacehub auth login --agent "$ALICE"
expect_fail "names the proxy needs are refused" "reserved" as carol spacehub auth login --builder v1
check "auth status shows the builder" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub auth status | grep -q 'builder   $ALICE'"
check "same builder on another machine (token + --with-token)" bash -c \
  "SPACEHUB_HOME='$WORK/home-alice' spacehub auth token | SPACEHUB_HOME='$WORK/home-alice2' spacehub auth login --with-token | grep -q 'as builder $ALICE'"
expect_fail "logout asks for --yes" "--yes" as alice2 spacehub auth logout
check "logout" as alice2 spacehub auth logout --yes

# Remotes we write always name the hub: quirq://<host>/<owner>/<space>.
HUB="quirq://${SPACEHUB_SERVER#*://}"

echo "spaces"
check "project create" as alice spacehub project create notes -d "e2e space"
expect_fail "project names are unique per space" "already exists" as alice spacehub project create notes
check "project list shows it" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project list $ALICE | grep -q $NOTES"
check "repo is an alias of space" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub repo list | grep -q $NOTES"
expect_fail "a missing project explains how to create it" "spacehub project create" \
  as alice git -C "$WORK" ls-remote "$HUB/$ALICE/missing"
expect_fail "non-owner cannot delete" "permission denied" as bob spacehub project delete "$NOTES" --yes

echo "first push and clone"
A="$WORK/a"; B="$WORK/b"
git init -q -b main "$A"
cd "$A"
echo hello >a.txt; mkdir -p d/e; echo deep >d/e/b.txt; printf '\x00\x01binary' >bin.dat; : >empty.txt
printf '# Notes\n\nSome *notes* and a [link](d/e/b.txt).\n\n| key | value |\n|-----|-------|\n| a   | 1     |\n' >README.md
git add . && commit -m first
echo two >>a.txt && commit -am second
git remote add quirq "$HUB/$NOTES"
as alice git push -q quirq main 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "first push"; }
ok "push to an empty space"
check "project view lists heads/main" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project view $NOTES | grep -q heads/main"
check "space view infers the project inside a clone (older form)" bash -c "cd '$A' && SPACEHUB_HOME='$WORK/home-alice' spacehub space view | grep -q 'url       $HUB/$NOTES'"
as bob spacehub project clone "$NOTES" "$B" -- -q 2>/dev/null
same "clone matches (anyone can read)" "$(git -C "$B" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
same "clone checks out the default branch" "$(git -C "$B" symbolic-ref HEAD)" "refs/heads/main"
check "binary content round-trips" cmp -s "$A/bin.dat" "$B/bin.dat"
check "clone passes git fsck" git -C "$B" fsck --strict

echo "permissions"
cd "$B"; echo bob >>a.txt; commit -am "bob edit"
expect_fail "non-owner cannot push" "permission denied" as bob git push quirq main

echo "older remotes"
OLD="$WORK/old"
check "an old spacehub:// remote still fetches" as alice git -C "$WORK" clone -q "spacehub://$NOTES" "$OLD"
same "and holds the same commit" "$(git -C "$OLD" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
check "a short quirq://owner/space uses the logged-in hub" as alice git -C "$WORK" ls-remote "quirq://$NOTES"

echo "sync between two working copies"
C="$WORK/c"
(cd "$WORK" && as alice spacehub space clone notes c -- -q 2>/dev/null)
cd "$C"; echo three >>a.txt; commit -am third
same "space clone of a bare project name still works (older form)" "$(git -C "$C" remote)" "quirq"
same "clone points the remote at a quirq URL" "$(git -C "$C" remote get-url quirq)" "$HUB/$NOTES"
check "push from a second clone" as alice git push -q quirq main
cd "$A"; as alice spacehub project sync >/dev/null 2>&1
same "project sync fast-forwards the first clone" "$(git -C "$A" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
D="$WORK/d"; (cd "$WORK" && as alice spacehub project clone notes d -- -q 2>/dev/null)
(cd "$D" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch >"$WORK/watch.log" 2>&1) &
WATCH_PID=$!
sleep 2
cd "$C"; echo live >>a.txt; commit -am live; as alice git push -q quirq main 2>/dev/null
for _ in $(seq 1 50); do
  [[ "$(git -C "$D" rev-parse HEAD)" == "$(git -C "$C" rev-parse HEAD)" ]] && break
  sleep 0.2
done
kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null || true
same "space sync --watch (older form) pulls a push live" "$(git -C "$D" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
cd "$A"; as alice git pull --ff-only quirq main 2>/dev/null

echo "history rules"
cd "$A"; echo diverge >>a.txt; commit -am "diverge A"
cd "$C"; echo other >>a.txt; commit -am "diverge C"
check "C pushes first" as alice git push -q quirq main
cd "$A"
expect_fail "non-fast-forward is rejected" "rejected\|non-fast-forward\|fetch first" as alice git push quirq main
expect_fail "stale lease is rejected" "stale\|rejected" \
  as alice git push --force-with-lease=main:"$(git rev-parse HEAD~1)" quirq main
check "a lease that a branch is new creates it" as alice git push -q --force-with-lease=refs/heads/leased: quirq HEAD:refs/heads/leased
expect_fail "and refuses once it exists" "stale\|rejected" as alice git push --force-with-lease=refs/heads/leased: quirq HEAD~1:refs/heads/leased
check "delete it" as alice git push -q quirq :leased
check "force push overwrites" as alice git push --force quirq main
same "remote now holds A's commit" "$(as alice git ls-remote quirq refs/heads/main | cut -f1)" "$(git rev-parse HEAD)"

echo "branches, merges and tags"
git checkout -q -b feature; echo f >f.txt; git add f.txt; commit -m feature
git checkout -q main; echo m >m.txt; git add m.txt; commit -m "main work"
git merge -q --no-ff -m "merge feature" feature
check "push a merge and a second branch" as alice git push -q quirq main feature
git tag v1; git -c user.name=e2e -c user.email=e2e@example.com tag -a v2 -m "annotated"
check "push light and annotated tags" as alice git push -q quirq v1 v2
expect_fail "moving an existing tag needs force" "already exists\|rejected" \
  bash -c "cd '$A' && git tag -f v1 HEAD~1 && SPACEHUB_HOME='$WORK/home-alice' git push quirq v1"
check "delete a branch" as alice git push -q quirq :feature
cd "$C"; as alice git fetch --tags quirq 2>/dev/null
same "fetch brings the merge" "$(git rev-parse quirq/main)" "$(git -C "$A" rev-parse main)"
same "annotated tag fetched as a tag object" "$(git cat-file -t v2)" "tag"
as alice git fetch --prune quirq 2>/dev/null
check "pruned deleted branch" bash -c "! git rev-parse -q --verify refs/remotes/quirq/feature"
git reset -q --hard quirq/main  # C's own commit was force-pushed over

echo "large objects and incremental fetch"
cd "$A"
python3 -c "import os; open('big.bin','wb').write(os.urandom(5*1024*1024+123))"
python3 - <<'EOF'
import os
os.makedirs('many', exist_ok=True)
for i in range(1500):
    open(f'many/f{i}.txt', 'w').write(f'{i}\n' + os.urandom(6000).hex())
EOF
git add . && commit -m "big file and many files"
check "push 5 MiB blob (chunked) and 1500 files" as alice git push -q quirq main
cd "$C"
out="$(as alice git pull --ff-only quirq main 2>&1)" || { echo "$out" >&2; fail "pull large push"; }
check "chunked blob round-trips byte for byte" cmp -s "$A/big.bin" "$C/big.bin"
same "multi-window fetch is complete" "$(git rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
check "fsck after large fetch" git fsck --strict
cd "$A"; echo tiny >tiny.txt; git add tiny.txt; commit -m tiny
as alice git push -q quirq main 2>/dev/null
cd "$C"
out="$(as alice git fetch quirq 2>&1)" || { echo "$out" >&2; fail "incremental fetch"; }
grep -q "received 3 objects" <<<"$out" && ok "incremental fetch only downloads new objects" \
  || { echo "$out" >&2; fail "incremental fetch"; }
rm -rf "$C/.git/spacehub"
echo again >>"$A/tiny.txt"; git -C "$A" add tiny.txt; (cd "$A" && commit -m again && as alice git push -q quirq main 2>/dev/null)
as alice git fetch -q quirq 2>/dev/null
same "fetch without a fetch record still works" "$(git rev-parse quirq/main)" "$(git -C "$A" rev-parse HEAD)"

echo "web UI"
page_has "home has the short guide" "" "Get started"
page_has "home links to the full guide" "" "Read the guide"
page_has "guide: what it is" "-/guide" 'id="what"'
page_has "guide: who can use it" "-/guide" 'id="who"'
page_has "guide: how to use it" "-/guide" 'id="how"'
page_has "guide: use cases" "-/guide" 'id="use-cases"'
page_has "guide: editing together" "-/guide" 'id="together"'
status_is "the old guide address redirects" "guide" 301
page_has "home lists the space" "" "$NOTES"
page_has "owner page lists the space" "$ALICE" "notes"
page_has "space page shows the file tree" "$NOTES" "many"
page_has "folder page" "$NOTES/tree/main/d/e" "b.txt"
page_has "file page shows content" "$NOTES/blob/main/a.txt" "hello"
page_has "branch with a tag ref" "$NOTES/tree/v2" "a.txt"
page_has "commit log" "$NOTES/commits/main" "big file and many files"
page_has "commit page lists changed files" "$NOTES/commit/$(git -C "$A" rev-parse HEAD)" "tiny.txt"
page_has "branches and tags" "$NOTES/refs" "v2"
same "raw binary is served as bytes" "$(curl -s -o /dev/null -w '%{content_type}' "$(ui "$NOTES/raw/main/bin.dat")")" "application/octet-stream"
status_is "unknown project is a 404" "$ALICE/nope" 404
page_has "README renders as Markdown" "$NOTES" "<td>1</td>"
page_has "README links are real links" "$NOTES" ">link</a>"
page_has "Markdown source view" "$NOTES/blob/main/README.md?plain=1" 'id="L1"'
page_has "branch and tag picker" "$NOTES/tree/main" 'class="menu"'
page_has "file history" "$NOTES/commits/main/a.txt" "second"
page_has "commit page shows line diffs" "$NOTES/commit/$(git -C "$A" rev-parse HEAD)" 'class="add"'
page_has "empty file is browsable" "$NOTES/blob/main/empty.txt" "0 lines"

echo "builders"
view_has() { # view_has <label> <space> <text>
  check "$1" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project view '$2' | grep -qF -- '$3'"
}
view_has "view names the space" "$NOTES" "space     $ALICE"
view_has "the space's builder is the default builder" "$NOTES" "builder   $ALICE (builder)"
page_has "home lists builders" "" "Builders"
page_has "the builder shows on the builders page" "-/builders" "$ALICE"
expect_fail "builder credits must be GitHub accounts" "GitHub user or organization" as alice spacehub project edit "$NOTES" --builder "Octo Team"
check "credit a GitHub account" as alice spacehub project edit "$NOTES" --builder octocat
view_has "view shows the GitHub builder" "$NOTES" "builder   octocat (github.com/octocat)"
page_has "space page credits the builder" "$NOTES" "Built by"
page_has "GitHub builder page lists the project" "-/builders/octocat" "$NOTES"
page_has "home lists the GitHub builder" "" '<span class="pill">GitHub</span>'
check "a github.com URL works too" as alice spacehub project edit "$NOTES" --builder https://github.com/octocat
check "reset the builder" as alice spacehub project edit "$NOTES" --builder ""
view_has "back to the space's builder" "$NOTES" "builder   $ALICE (builder)"
expect_fail "non-owner cannot set the builder" "permission denied" as bob spacehub project edit "$NOTES" --builder x

echo "activity"
page_has "home shows the activity feed" "" ">Activity<"
page_has "builders appear in the feed" "" "joined as a builder"
page_has "space activity tab" "$NOTES/activity" "Activity"
page_has "pushes appear with commit counts" "$NOTES/activity" "pushed 1 commit to"
page_has "new branches appear" "$NOTES/activity" "created branch"
page_has "force pushes appear" "$NOTES/activity" "force-pushed branch"
page_has "tags appear" "$NOTES/activity" "created tag"
page_has "deleted branches appear" "$NOTES/activity" "deleted branch feature"
page_has "builder credits appear" "$NOTES/activity" "credited"
page_has "removed credits appear" "$NOTES/activity" "removed the builder credit"
for i in $(seq 1 31); do as alice spacehub project edit "$NOTES" -d "revision $i" >/dev/null; done
page_has "edits appear" "$NOTES/activity" "changed the description"
page_has "activity is paginated" "$NOTES/activity" ">Older<"
page_has "older activity on page 2" "$NOTES/activity?page=2" ">Newer<"

echo "web service (sign up, create, import)"
if [[ -n "${SPACEHUB_E2E_SERVER:-}" ]]; then
  WEB="${SPACEHUB_SERVER/#ws/http}"
else
  WEB_PORT=$((PORT + 1))
  # A stand-in for GitHub's API (unless the real one is wanted), serving
  # $GH/api/<path>.json; its repositories are bare repos under $GH/git.
  GH="$WORK/gh"; GH_PORT=$((PORT + 2)); mkdir -p "$GH/api/users"
  cat >"$GH/fake.py" <<'PY'
import http.server, os, sys, urllib.parse
root, port = sys.argv[1], int(sys.argv[2])
class Api(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        f = os.path.join(root, 'api', urllib.parse.urlparse(self.path).path.strip('/') + '.json')
        found = os.path.isfile(f)
        body = open(f, 'rb').read() if found else b'{"message": "Not Found"}'
        self.send_response(200 if found else 404)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(('127.0.0.1', port), Api).serve_forever()
PY
  echo '{"login": "octocat", "name": "The Octocat"}' >"$GH/api/users/octocat.json"
  GH_ENV=()
  if [[ "${SPACEHUB_E2E_GITHUB:-}" != 1 ]]; then
    python3 "$GH/fake.py" "$GH" "$GH_PORT" & BG="$BG $!"
    GH_ENV=(SPACEHUB_GITHUB_API="http://127.0.0.1:$GH_PORT")
  fi
  env ${GH_ENV[@]+"${GH_ENV[@]}"} SPACEHUB_ADMIN_TOKEN="$ADMIN_TOKEN" SPACEHUB_GITHUB_SYNC_MINUTES=0 \
    SPACEHUB_WEB_PORT=$WEB_PORT node "$ROOT/cli/dist/web.mjs" >"$WORK/web.log" 2>&1 &
  WEB_PID=$!
  WEB="http://127.0.0.1:$WEB_PORT"
  for _ in $(seq 1 50); do curl -s -o /dev/null "$WEB/-/login" && break; sleep 0.1; done
fi
JAR="$WORK/jar"; WEBUSER="web$RUN"
form() { # form <path> key=value... -> "<status> <location>"
  local url="$1"; shift; local args=()
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -s -o "$WORK/form.html" -w '%{http_code} %{redirect_url}' -b "$JAR" -c "$JAR" -H "Origin: $WEB" -X POST "$WEB$url" ${args[@]+"${args[@]}"}
}
same "sign up from the browser" "$(form /-/signup "username=$WEBUSER" | cut -d' ' -f1)" "200"
grep -q "spacehub_session" "$JAR" && ok "session cookie set" || fail "session cookie set"
same "create an empty space from the browser" "$(form /-/new name=fromweb 'description=made in the UI')" "303 $WEB/$WEBUSER/fromweb"
check "the CLI sees it" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project list $WEBUSER | grep -q '$WEBUSER/fromweb'"
same "forms from another site are refused" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$WEB/-/new" --data name=x)" "403"
same "only GitHub URLs can be imported" "$(form /-/new github=https://example.com/a/b | cut -d' ' -f1)" "400"
same "Built by must be a GitHub account" "$(form /-/new name=badbuilder "builder=Ada Lovelace" | cut -d' ' -f1)" "400"
same "create with a GitHub builder" "$(form /-/new name=withbuilder builder=https://github.com/octocat)" "303 $WEB/$WEBUSER/withbuilder"
page_has "the form's builder is credited" "-/builders/octocat" "$WEBUSER/withbuilder"
WEBTOKEN="$(python3 -c "import sys,urllib.parse;[print(urllib.parse.unquote(l.split()[-1])) for l in open(sys.argv[1]) if 'spacehub_session' in l]" "$JAR")"
same "sign out" "$(form /-/logout | cut -d' ' -f1)" "303"
same "signed-out users are sent to sign in" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b "$JAR" "$WEB/-/new")" "303 $WEB/-/login?next=%2F-%2Fnew"
same "a bad token is refused" "$(form /-/login token=nonsense | cut -d' ' -f1)" "400"
same "sign in with the token" "$(form /-/login "token=$WEBTOKEN" next=/)" "303 $WEB/"
if [[ "${SPACEHUB_E2E_GITHUB:-}" == 1 ]]; then
  same "import from GitHub" "$(form /-/new github=https://github.com/octocat/Hello-World)" "303 $WEB/$WEBUSER/Hello-World"
  for _ in $(seq 1 60); do
    SPACEHUB_HOME="$WORK/home-alice" spacehub project view "$WEBUSER/Hello-World" 2>/dev/null | grep -q "heads/master" && break
    sleep 1
  done
  check "imported branches are there" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project view $WEBUSER/Hello-World | grep -q heads/master"
  page_has "the GitHub owner is the builder" "-/builders/octocat" "$WEBUSER/Hello-World"
  page_has "with GitHub's display name" "$WEBUSER/Hello-World" "The Octocat"
  page_has "imports appear in the space's activity" "$WEBUSER/Hello-World/activity" "imported"
fi

echo "team spaces"
TEAM="team$RUN"; CAROL="carol$RUN"; T="$WORK/t"
check "a third builder" as carol spacehub auth login --builder "$CAROL"
check "create a team space" as alice spacehub space create "$TEAM" -d "e2e team"
expect_fail "builders and team spaces share names" "taken" as alice spacehub space create "$BOB"
check "space list shows the team" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space list | grep -q '^$TEAM  *team'"
check "every builder has a personal space" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space list $ALICE | grep -q '^$ALICE  *builder'"
git init -q -b main "$T"; (cd "$T" && echo site >index.html && git add . && commit -m site)
expect_fail "only members create projects in a team" "permission denied" as bob spacehub project create "$TEAM/site"
expect_fail "only owners add members" "permission denied" as bob spacehub space member add "$TEAM" "$BOB"
check "the owner adds a member" as alice spacehub space member add "$TEAM" "$BOB"
check "member list shows owner and member" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space member list $TEAM | tr -s ' ' | grep -q '^$BOB member$'"
check "a member creates a project in the team and pushes" as bob spacehub project create "$TEAM/site" --source "$T" --push
same "the project lives at <team>/<project>" "$(as bob git -C "$T" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$T" rev-parse HEAD)"
expect_fail "builders outside the team cannot push" "permission denied" \
  bash -c "cd '$T' && echo x >>index.html && git -c user.name=e2e -c user.email=e2e@example.com commit -qam x && SPACEHUB_HOME='$WORK/home-carol' git push quirq main"
git -C "$T" reset -q --hard HEAD~1
check "space view shows the team" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $TEAM | grep -q 'members   $BOB'"
page_has "the team page lists its projects" "$TEAM" "site"
check "and its members" bash -c "curl -sf '$(ui "$TEAM")' | grep -q 'members\"><table><tr><td><a[^>]*><b>$ALICE</b>'"
page_has "the project names its space" "$TEAM/site" '<span class="pill">team</span>'
page_has "the project credits the builder who made it" "$TEAM/site" "Built by"
page_has "team changes appear in the activity" "" "created the team space"
same "the web form refuses spaces you are not in" "$(form /-/new "space=$TEAM" name=nope | cut -d' ' -f1)" "400"
expect_fail "a team with projects cannot be deleted" "still has" as alice spacehub space delete "$TEAM" --yes
check "a member can leave" as bob spacehub space member remove "$TEAM" "$BOB"
page_has "leaving appears in the activity" "" "left <a"
check "delete the team's project" as alice spacehub project delete "$TEAM/site" --yes
check "then the empty team" as alice spacehub space delete "$TEAM" --yes
status_is "a deleted team is gone" "$TEAM" 404

echo "GitHub links"
if [[ -n "${SPACEHUB_E2E_SERVER:-}" || "${SPACEHUB_E2E_GITHUB:-}" == 1 ]]; then
  echo "  (skipped: these use the stand-in GitHub, which only a local run starts)"
else
ORG="acme$RUN"; MIRROR="mirror$RUN"
gh_commit() { # gh_commit <repo> <file> <text> [<branch>]: a commit pushed to the stand-in GitHub
  local dir="$GH/work/$1" branch="${4:-main}"
  if [[ ! -d "$dir" ]]; then
    git init -q --bare -b main "$GH/git/$ORG/$1.git"
    git init -q -b main "$dir"; git -C "$dir" remote add origin "$GH/git/$ORG/$1.git"
  fi
  git -C "$dir" checkout -q -B "$branch"
  echo "$3" >"$dir/$2"; git -C "$dir" add . && git -C "$dir" -c user.name=gh -c user.email=gh@example.com commit -q -m "$3"
  git -C "$dir" push -q origin "$branch"; git -C "$dir" checkout -q main
}
gh_list() { # gh_list <repo>...: the repositories the stand-in API lists for $ORG
  python3 - "$GH" "$ORG" "$@" <<'PY'
import json, os, sys
gh, org, names = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(f"{gh}/api/users/{org}", exist_ok=True)
repos = [{"name": n, "html_url": f"https://github.com/{org}/{n}", "clone_url": f"{gh}/git/{org}/{n}.git", "description": f"{n} from GitHub", "size": 1, "private": False} for n in names]
json.dump(repos, open(f"{gh}/api/users/{org}/repos.json", "w"))
json.dump({"login": org, "name": "Acme Corp"}, open(f"{gh}/api/users/{org}.json", "w"))
PY
}
hub_oid() { as alice git ls-remote "$HUB/$1" "$2" 2>/dev/null | cut -f1; }
gh_oid() { git -C "$GH/git/$ORG/$1.git" rev-parse "$2"; }
listed() { as alice spacehub project list "$MIRROR" | grep -q "^$MIRROR/$1 "; }
synced() { as alice spacehub space view "$MIRROR" | grep -q "^github .*(synced"; }
gh_commit one README.md "one v1"; gh_commit two README.md "two v1"; gh_commit two old.txt "an old branch" old
gh_list one two
check "a team space to mirror GitHub into" as alice spacehub space create "$MIRROR"
expect_fail "only owners link a space" "permission denied" as bob spacehub space link "$MIRROR" "https://github.com/$ORG"
check "link it to a GitHub organization" as alice spacehub space link "$MIRROR" "https://github.com/$ORG"
both_listed() { listed one && listed two; }
check "its repositories become projects with the same names" wait_for 40 both_listed
check "the sync finishes" wait_for 40 synced
same "with GitHub's branches" "$(hub_oid "$MIRROR/one" refs/heads/main)" "$(gh_oid one main)"
same "all of them" "$(hub_oid "$MIRROR/two" refs/heads/old)" "$(gh_oid two old)"
page_has "credited to the GitHub account" "$MIRROR/one" "Acme Corp"
page_has "the space page shows what it mirrors" "$MIRROR" "Mirrors"
page_has "the sync is in the activity" "" "GitHub sync</b> synced"
check "a member to work on the mirror" as alice spacehub space member add "$MIRROR" "$BOB"
M1="$WORK/m1"; as bob spacehub project clone "$MIRROR/one" "$M1" -- -q 2>/dev/null
(cd "$M1" && echo "hub work" >hub.txt && git add hub.txt && commit -m "work done on the hub" && as bob git push -q quirq main 2>/dev/null)
HUB_WORK="$(git -C "$M1" rev-parse HEAD)"
gh_commit one README.md "one v2, another way on GitHub"
gh_commit two README.md "two v2"
git -C "$GH/work/two" push -q origin --delete old
gh_commit three README.md "three v1"
gh_list one two three
check "ask for a sync" as alice spacehub space link "$MIRROR" --sync
check "new GitHub repositories arrive" wait_for 40 listed three
followed() { [[ "$(hub_oid "$MIRROR/two" refs/heads/main)" == "$(gh_oid two main)" ]]; }
old_gone() { [[ -z "$(hub_oid "$MIRROR/two" refs/heads/old)" ]]; }
check "untouched branches follow GitHub" wait_for 40 followed
check "branches deleted on GitHub go too" wait_for 20 old_gone
check "that sync finishes" wait_for 40 synced
same "work done on the hub is never overwritten" "$(hub_oid "$MIRROR/one" refs/heads/main)" "$HUB_WORK"
check "the branch is marked diverged" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project view $MIRROR/one | grep -q 'heads/main .*diverged from GitHub'"
page_has "the refs page says so" "$MIRROR/one/refs" "diverged from GitHub"
page_has "and so does the activity" "$MIRROR/one/activity" "diverged from GitHub"
gh_commit one README.md "one v3"
check "a diverged branch stays put on the next sync" as alice spacehub space link "$MIRROR" --sync
check "which finishes too" wait_for 40 synced
same "still the hub's work" "$(hub_oid "$MIRROR/one" refs/heads/main)" "$HUB_WORK"
check "unlink" as alice spacehub space link "$MIRROR" --remove
check "the projects stay" listed three
fi

echo "collaborators"
PAD="$ALICE/pad"; X="$WORK/x"; Y="$WORK/y"
who_has() { as alice spacehub space who "$PAD" | grep -q -- "$1"; }
check "project create pad" as alice spacehub project create pad
git init -q -b main "$X"
(cd "$X" && echo one >shared.txt && git add . && commit -m pad && git remote add quirq "$HUB/$PAD")
check "the owner pushes" as alice git -C "$X" push -q quirq main
as bob spacehub project clone "$PAD" "$Y" -- -q 2>/dev/null
(cd "$Y" && echo bob >bob.txt && git add bob.txt && commit -m "bob joins")
expect_fail "a non-collaborator cannot push" "permission denied" as bob git -C "$Y" push quirq main
expect_fail "only the owner adds collaborators" "permission denied" as bob spacehub project member add "$PAD" "$BOB"
expect_fail "collaborators must be builders" "no builder or agent named" as alice spacehub project member add "$PAD" "nobody$RUN"
check "the owner adds a collaborator (older form: space member add space/project)" as alice spacehub space member add "$PAD" "$BOB"
check "member list shows the collaborator" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project member list $PAD | grep -q '^$BOB  *collaborator'"
check "a collaborator can push" as bob git -C "$Y" push -q quirq main
check "the owner pulls the member's commit" as alice git -C "$X" pull -q --ff-only quirq main
view_has "view lists the collaborators" "$PAD" "collaborators  $BOB"
check "the project page lists the collaborators" bash -c "curl -sf '$(ui "$PAD")' | grep -q 'class=\"collaborators\"><a[^>]*>$BOB<'"
page_has "collaborator changes appear in the activity" "$PAD/activity" "as a collaborator on"
page_has "the member's page lists the space" "$BOB" "Member of"

echo "live pages"
proxied() { # proxied <path>: a page as the server's proxy serves it
  if [[ -n "${SPACEHUB_E2E_SERVER:-}" ]]; then curl -sf "$WEB$1"
  else curl -sf -H "X-Spacehub-Uri: $1" "http://127.0.0.1:$PORT/v1/database/$SPACEHUB_DB/route/ui"; fi
}
same "live.js is served by the web service" "$(curl -s -o /dev/null -w '%{content_type}' "$WEB/-/live.js")" "text/javascript; charset=utf-8"
proxied_has() { local body; body="$(proxied "$1")" || return 1; grep -qF -- "$2" <<<"$body"; }
proxied_lacks() { local body; body="$(proxied "$1")" || return 1; ! grep -qF -- "$2" <<<"$body"; }
last_page_has() { grep '^data: ' "$LIVE" | tail -n 1 | grep -q -- "$1"; }
check "project pages load it behind the proxy" proxied_has "/$PAD" 'src="/-/live.js"'
check "the guide does not" proxied_lacks /-/guide 'live.js'
same "pages that never change get no stream" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/-/live?path=/-/guide")" "204"
same "bad live paths are refused" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/-/live?path=//evil.example")" "400"
LIVE="$WORK/live.log"
curl -sN --max-time 300 "$WEB/-/live?path=/$PAD" >"$LIVE" 2>/dev/null &
LIVE_PID=$!; BG="$BG $LIVE_PID"
check "the stream is an event stream" wait_for 10 grep -q "^retry: " "$LIVE"
check "it sends the page's current rendering" wait_for 10 grep -q "^event: page" "$LIVE"

echo "presence"
(cd "$X" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space watch >"$WORK/xwatch.log" 2>&1) &
WATCHER=$!; BG="$BG $WATCHER"
check "space who lists the watcher" wait_for 15 who_has "^$ALICE  *watch"
check "the project page shows who is here" bash -c "curl -sf '$(ui "$PAD")' | grep -qF '<b>$ALICE</b></a> <span class=\"pill\">watch</span>'"
check "so does the home page" bash -c "curl -sf '$(ui "")' | grep -qF '<b>$ALICE</b></a> <span class=\"pill\">watch</span>'"
check "the live page shows the watcher without a reload" wait_for 10 grep -q "$ALICE</b></a> <span class=..pill..>watch" "$LIVE"
kill "$WATCHER"; wait "$WATCHER" 2>/dev/null || true
check "presence ends with the connection" wait_for 15 who_has "nobody is connected"
check "and the live page drops it" wait_for 10 last_page_has "Nobody is connected right now"

echo "autosync"
(cd "$X" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch --auto --interval 0.5 >"$WORK/auto-alice.log" 2>&1) &
AX=$!; BG="$BG $AX"
(cd "$Y" && SPACEHUB_HOME="$WORK/home-bob" exec spacehub space sync --auto --interval 0.5 >"$WORK/auto-bob.log" 2>&1) &
AY=$!; BG="$BG $AY"
check "both autosyncs show as here" wait_for 15 bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space who $PAD | grep -c ' autosync  main' | grep -q '^2$'"
echo "from alice" >"$X/alice.txt"
mkdir -p "$Y/notes"; echo "from bob" >"$Y/notes/bob.txt"
converged() {
  [[ -f "$X/notes/bob.txt" && -f "$Y/alice.txt" ]] || return 1
  [[ "$(git -C "$X" rev-parse HEAD)" == "$(git -C "$Y" rev-parse HEAD)" ]] || return 1
  [[ "$(as alice git -C "$X" ls-remote quirq refs/heads/main | cut -f1)" == "$(git -C "$X" rev-parse HEAD)" ]]
}
check "two clones editing different files converge, no manual pull" wait_for 30 converged
same "with nothing left uncommitted" "$(git -C "$X" status --porcelain)$(git -C "$Y" status --porcelain)" ""
check "autosync commits name their files" bash -c "git -C '$X' log --format=%s -3 | grep -q '^autosync: notes/bob.txt$'"
check "the live page shows the new commits" wait_for 10 grep -q "autosync: " "$LIVE"
both_editing() { last_page_has "$ALICE</b></a> <span class=..pill..>autosync" && last_page_has "$BOB</b></a> <span class=..pill..>autosync"; }
check "and both editors" wait_for 10 both_editing
echo alice >"$X/shared.txt"; echo bob >"$Y/shared.txt"
one_stopped() { ! kill -0 "$AX" 2>/dev/null || ! kill -0 "$AY" 2>/dev/null; }
check "editing the same line stops one autosync" wait_for 30 one_stopped
if kill -0 "$AX" 2>/dev/null; then
  WIN=$AX; WON="$X"; LOSE=$AY; LOST="$Y"; LOSER=bob
else
  WIN=$AY; WON="$Y"; LOSE=$AX; LOST="$X"; LOSER=alice
fi
code=0; wait "$LOSE" || code=$?
same "it exits with status 2" "$code" "2"
check "and says what to resolve" grep -q "conflict with the hub's main in:" "$WORK/auto-$LOSER.log"
check "naming the file" grep -qx "  shared.txt" "$WORK/auto-$LOSER.log"
same "the copy is left mid-rebase on that file" "$(git -C "$LOST" diff --name-only --diff-filter=U)" "shared.txt"
check "with git's conflict markers" grep -q '^<<<<<<<' "$LOST/shared.txt"
check "the other autosync keeps going" kill -0 "$WIN"
same "the hub holds the other edit" "$(as alice git -C "$X" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$WON" rev-parse HEAD)"
kill "$WIN"; wait "$WIN" 2>/dev/null || true
expect_fail "autosync will not start mid-rebase" "unfinished rebase" as "$LOSER" bash -c "cd '$LOST' && spacehub space sync --auto"
git -C "$LOST" rebase --abort
check "space who is empty again" wait_for 15 who_has "nobody is connected"

echo "removing collaborators"
check "the owner removes the collaborator" as alice spacehub project member remove "$PAD" "$BOB"
page_has "removals appear in the activity" "$PAD/activity" "from the collaborators on"
as bob git -C "$Y" fetch -q quirq 2>/dev/null; git -C "$Y" reset -q --hard quirq/main
(cd "$Y" && echo late >late.txt && git add late.txt && commit -m late)
expect_fail "a removed collaborator cannot push" "permission denied" as bob git -C "$Y" push quirq main
kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null || true

echo "whole spaces"
WS="ws$RUN"; WA="$WORK/ws-alice"; WB="$WORK/ws-bob"
check "a team space with two projects" as alice spacehub space create "$WS"
check "and a member" as alice spacehub space member add "$WS" "$BOB"
for name in one two; do
  git init -q -b main "$WORK/src-$name"; (cd "$WORK/src-$name" && echo "$name" >shared.txt && git add . && commit -m "$name")
  as alice spacehub project create "$WS/$name" --source "$WORK/src-$name" --push >/dev/null 2>&1
done
check "space clone clones every project into one folder" as alice spacehub space clone "$WS" "$WA"
same "each one at the hub's commit" "$(git -C "$WA/one" rev-parse HEAD)" "$(git -C "$WORK/src-one" rev-parse HEAD)"
check "the folder lists its projects" grep -q '"two"' "$WA/.spacehub/space.json"
check "the member clones it too" as bob spacehub space clone "$WS" "$WB"
expect_fail "into an empty folder only" "not empty" as bob spacehub space clone "$WS" "$WB"
(cd "$WA" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch --auto --interval 0.5 >"$WORK/ws-alice.log" 2>&1) &
SA=$!; BG="$BG $SA"
(cd "$WB" && SPACEHUB_HOME="$WORK/home-bob" exec spacehub space sync --watch --auto --interval 0.5 >"$WORK/ws-bob.log" 2>&1) &
SB=$!; BG="$BG $SB"
ws_who() { as alice spacehub space who "$WS" | grep -c "autosync  (all projects)" | grep -q '^2$'; }
check "space who shows both following the whole space" wait_for 15 ws_who
page_has "project pages show them as here" "$WS/one" "all projects"
echo alice >"$WA/one/from-alice.txt"; echo bob >"$WB/two/from-bob.txt"
ws_converged() {
  [[ -f "$WB/one/from-alice.txt" && -f "$WA/two/from-bob.txt" ]] || return 1
  [[ "$(git -C "$WA/one" rev-parse HEAD)" == "$(git -C "$WB/one" rev-parse HEAD)" ]] || return 1
  [[ "$(git -C "$WA/two" rev-parse HEAD)" == "$(git -C "$WB/two" rev-parse HEAD)" ]]
}
check "edits in different projects reach both folders" wait_for 30 ws_converged
git init -q -b main "$WORK/src-three"; (cd "$WORK/src-three" && echo three >shared.txt && git add . && commit -m three)
check "a new project in the space" as alice spacehub project create "$WS/three" --source "$WORK/src-three" --push
ws_three() { [[ -f "$WA/three/shared.txt" && -f "$WB/three/shared.txt" ]] && grep -q '"three"' "$WB/.spacehub/space.json"; }
check "is cloned into both folders as it appears" wait_for 30 ws_three
echo "alice's line" >"$WA/one/shared.txt"; echo "bob's line" >"$WB/one/shared.txt"
one_paused() { grep -q "^.*one: paused" "$WORK/ws-alice.log" "$WORK/ws-bob.log"; }
check "a conflict pauses only its project" wait_for 30 one_paused
check "both syncs keep running" bash -c "kill -0 $SA && kill -0 $SB"
echo "still syncing" >"$WA/two/after.txt"
two_after() { [[ -f "$WB/two/after.txt" ]]; }
check "the other projects still sync" wait_for 30 two_after
check "the paused project says what to resolve" grep -q "conflict with the hub's main in:" "$WORK/ws-alice.log" "$WORK/ws-bob.log"
kill "$SA" "$SB" 2>/dev/null; wait "$SA" 2>/dev/null; wait "$SB" 2>/dev/null || true
for d in "$WA/one" "$WB/one"; do git -C "$d" rebase --abort 2>/dev/null || true; done
(cd "$WORK/src-two" && as alice git pull -q --ff-only quirq main 2>/dev/null && echo more >>shared.txt && commit -am more && as alice git push -q quirq main 2>/dev/null)
check "space sync once fast-forwards the folder" bash -c "cd '$WB' && SPACEHUB_HOME='$WORK/home-bob' spacehub space sync >/dev/null 2>&1 && [[ \$(git -C '$WB/two' rev-parse HEAD) == \$(git -C '$WORK/src-two' rev-parse HEAD) ]]"
check "space sync inside one project's clone syncs just that project" bash -c "cd '$WB/three' && SPACEHUB_HOME='$WORK/home-bob' spacehub space sync >/dev/null 2>&1"

echo "agents"
AG="scout$RUN"; AT="agteam$RUN"; AT2="agmore$RUN"; AW="$WORK/agent-run"
check "create an agent" as alice spacehub agent create "$AG" -d "e2e agent"
check "with its definition in <agent>/home" bash -c "SPACEHUB_HOME='$WORK/home-alice' git ls-remote '$HUB/$AG/home' refs/heads/main | grep -q main"
page_has "in the xo-agent-template layout" "$AG/home" "SOUL.md"
page_has "the agent has a page" "$AG" "Not running."
page_has "the builder's page lists it" "$ALICE" ">$AG</b>"
expect_fail "agents share names with builders and teams" "taken" as alice spacehub agent create "$BOB"
expect_fail "only its owners read its token" "permission denied" as bob spacehub agent token "$AG"
AG_TOKEN="$(as alice spacehub agent token "$AG")"
same "its owners do" "${AG_TOKEN:0:3}" "eyJ"
check "a team space for it to work in" as alice spacehub space create "$AT"
git init -q -b main "$WORK/src-work"; (cd "$WORK/src-work" && echo work >notes.txt && git add . && commit -m work)
as alice spacehub project create "$AT/work" --source "$WORK/src-work" --push >/dev/null 2>&1
expect_fail "others cannot connect it to their spaces" "permission denied" as bob spacehub agent connect "$AG" "$BOB"
check "connect it to the team" as alice spacehub agent connect "$AG" "$AT"
check "agent list shows the connection" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub agent list | grep -q '^$AG .*connected to $AT'"
# As XO Swarm launches it: logged in as the agent itself.
(env SPACEHUB_TOKEN="$AG_TOKEN" SPACEHUB_HOME="$WORK/home-agent" spacehub agent run "$AG" "$AW" --interval 0.5 --host e2e-host >"$WORK/agent.log" 2>&1) &
AR=$!; BG="$BG $AR"
agent_ready() { [[ -f "$AW/$AG/home/SOUL.md" && -f "$AW/$AT/work/notes.txt" ]]; }
check "agent run checks out its home and every connected space" wait_for 30 agent_ready
agent_here() { as alice spacehub space who "$AT" | grep -q "^$AG  *agent"; }
check "it shows as running in the space" wait_for 15 agent_here
page_has "and on its page, with its host" "$AG" "e2e-host"
echo "found something" >"$AW/$AT/work/finding.txt"
agent_pushed() { [[ "$(as alice git ls-remote "$HUB/$AT/work" refs/heads/main | cut -f1)" == "$(git -C "$AW/$AT/work" rev-parse HEAD)" ]] && [[ -n "$(as alice git ls-remote "$HUB/$AT/work" refs/heads/main)" ]] && git -C "$AW/$AT/work" log -1 --format=%s | grep -q finding; }
check "what it writes is pushed" wait_for 30 agent_pushed
same "as the agent" "$(git -C "$AW/$AT/work" log -1 --format=%an)" "$AG"
page_has "credited to the agent in the activity" "$AT/work/activity" "<b>$AG</b>"
echo "learned a thing" >>"$AW/$AG/home/MEMORY.md"
memory_pushed() { as alice git ls-remote "$HUB/$AG/home" refs/heads/main | cut -f1 | grep -q "$(git -C "$AW/$AG/home" rev-parse HEAD)" && git -C "$AW/$AG/home" log -1 --format=%s | grep -q MEMORY; }
check "its memory goes back to its home" wait_for 30 memory_pushed
(cd "$WORK/src-work" && as alice git pull -q --ff-only quirq main 2>/dev/null && echo "from alice" >>notes.txt && commit -am "alice adds a note" && as alice git push -q quirq main 2>/dev/null)
alice_arrived() { grep -q "from alice" "$AW/$AT/work/notes.txt"; }
check "others' pushes reach its folder" wait_for 30 alice_arrived
check "a second space" as alice spacehub space create "$AT2"
git init -q -b main "$WORK/src-more"; (cd "$WORK/src-more" && echo more >more.txt && git add . && commit -m more)
as alice spacehub project create "$AT2/more" --source "$WORK/src-more" --push >/dev/null 2>&1
check "connect it while it runs" as alice spacehub agent connect "$AG" "$AT2"
more_ready() { [[ -f "$AW/$AT2/more/more.txt" ]]; }
check "and it starts following that space too" wait_for 30 more_ready
check "disconnect it" as alice spacehub agent disconnect "$AG" "$AT2"
dropped() { grep -q "$AT2: no longer connected" "$WORK/agent.log"; }
check "and it stops following that space" wait_for 20 dropped
kill "$AR" 2>/dev/null; wait "$AR" 2>/dev/null || true
agent_gone() { ! as alice spacehub space who "$AT" | grep -q "^$AG "; }
check "stopping it ends its presence" wait_for 15 agent_gone
(SPACEHUB_HOME="$WORK/home-alice" spacehub agent run "$AG" "$WORK/agent-owner" --interval 0.5 >"$WORK/agent-owner.log" 2>&1) &
AO=$!; BG="$BG $AO"
owner_ready() { [[ -f "$WORK/agent-owner/$AT/work/finding.txt" ]]; }
check "its owners can run it too (with its token from the hub)" wait_for 30 owner_ready
kill "$AO" 2>/dev/null; wait "$AO" 2>/dev/null || true
expect_fail "deleting it needs --yes" "--yes" as alice spacehub agent delete "$AG"
check "delete the agent and its home" as alice spacehub agent delete "$AG" --yes
status_is "it is gone" "$AG" 404
for t in "$AT" "$AT2"; do
  for p in $(as alice spacehub project list "$t" | cut -d' ' -f1); do as alice spacehub project delete "$p" --yes >/dev/null; done
  as alice spacehub space delete "$t" --yes >/dev/null
done

echo "create from an existing repo, edit"
P="$WORK/p"; git init -q -b main "$P"; (cd "$P" && echo p >p.txt && git add . && commit -m p)
check "space create --source --push still makes a project (older form)" as alice spacehub space create proj --source "$P" --push
same "pushed HEAD matches" "$(as alice git -C "$P" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$P" rev-parse HEAD)"
same "create --push sets no upstream" "$(git -C "$P" config branch.main.remote || echo none)" "none"
Q="$WORK/q"; git init -q -b main "$Q"; (cd "$Q" && echo q >q.txt && git add . && commit -m q && git remote add origin https://example.com/q.git)
check "create --source adds a quirq remote next to origin" as alice spacehub project create withorigin --source "$Q" --push
same "existing origin untouched" "$(git -C "$Q" remote get-url origin)" "https://example.com/q.git"
same "quirq remote holds HEAD" "$(as alice git -C "$Q" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$Q" rev-parse HEAD)"
expect_fail "a taken --remote name is refused before creating" "already has a remote" as alice spacehub project create other --source "$Q" --remote origin
expect_fail "so no project was created" "does not exist" as alice git ls-remote "$HUB/$ALICE/other"
check "delete that project (older form: space delete <name>)" as alice spacehub space delete withorigin --yes
check "project edit" as alice spacehub project edit proj --description "edited" --default-branch main
check "edit shows in view" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub project view $ALICE/proj | grep -q '^edited$'"

echo "deleting a builder"
LEAVER="leaver$RUN"; KEEP="keep$RUN"
check "a builder who will leave" as leaver spacehub auth login --builder "$LEAVER"
git init -q -b main "$WORK/src-leaver"; (cd "$WORK/src-leaver" && echo bye >bye.txt && git add . && commit -m bye)
check "with a project" as leaver spacehub project create gone --source "$WORK/src-leaver" --push
check "and a team space it owns alone" as leaver spacehub space create "$KEEP"
expect_fail "the last owner of a team cannot leave" "last owner of $KEEP" as leaver spacehub auth delete --yes
check "so it adds another owner" as leaver spacehub space member add "$KEEP" "$ALICE" --owner
expect_fail "deleting needs --yes, and says what goes" "for good, with 1 projects: gone" as leaver spacehub auth delete
check "and deletes itself" as leaver spacehub auth delete --yes
status_is "its space is gone" "$LEAVER" 404
expect_fail "and so is its project" "does not exist" as alice git ls-remote "$HUB/$LEAVER/gone"
check "its team stays, with the other owner" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space member list $KEEP | grep -q '^$ALICE  *owner'"
gone_from_feed() { local body; body="$(curl -sf "$(ui "")")" || return 1; ! grep -q "$LEAVER" <<<"$body"; }
check "nothing on the hub mentions it any more" gone_from_feed
check "it is logged out" bash -c "SPACEHUB_HOME='$WORK/home-leaver' spacehub auth status | grep -q 'not logged in'"
check "and its name is free again" as leaver2 spacehub auth login --builder "$LEAVER"
check "which can leave too" as leaver2 spacehub auth delete --yes
check "delete the kept team" as alice spacehub space delete "$KEEP" --yes

echo "clean up"
expect_fail "delete needs --yes" "--yes" as alice spacehub project delete "$NOTES"
check "delete project" as alice spacehub project delete "$NOTES" --yes
page_has "deletions stay in the hub feed" "" "deleted <b>$NOTES</b>"
check "delete second project" as alice spacehub project delete proj --yes
check "a collaborator again, to delete with the project" as alice spacehub project member add pad "$BOB"
member_rows() { # member_rows: the space_member rows naming bob (local server only)
  spacetime sql --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" "SELECT agent FROM space_member WHERE agent = '$BOB'"
}
has_member_rows() { local rows; rows="$(member_rows 2>/dev/null)" && grep -q "$BOB" <<<"$rows"; }
[[ -n "${SPACEHUB_E2E_SERVER:-}" ]] || check "collaborators are rows" has_member_rows
check "delete a project that has collaborators" as alice spacehub project delete pad --yes
if [[ -z "${SPACEHUB_E2E_SERVER:-}" ]]; then
  rows="$(member_rows 2>&1)" || fail "query space_member"
  grep -q "$BOB" <<<"$rows" && fail "its collaborators went with it" || ok "its collaborators went with it"
fi
expect_fail "deleted project is gone" "does not exist" as alice git ls-remote "$HUB/$NOTES"

echo "all $PASS checks passed"

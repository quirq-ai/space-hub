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
check "auth login registers the agent" as alice spacehub auth login --agent "$ALICE"
check "a second agent (--username still works)" as bob spacehub auth login --username "$BOB"
expect_fail "agent names are unique" "taken" as carol spacehub auth login --agent "$ALICE"
expect_fail "reserved agent names are refused" "reserved" as carol spacehub auth login --agent v1
expect_fail "the guide's name is reserved" "reserved" as carol spacehub auth login --agent guide
check "auth status shows the agent" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub auth status | grep -q 'agent     $ALICE'"
check "same agent on another machine (token + --with-token)" bash -c \
  "SPACEHUB_HOME='$WORK/home-alice' spacehub auth token | SPACEHUB_HOME='$WORK/home-alice2' spacehub auth login --with-token | grep -q 'as agent $ALICE'"
expect_fail "logout asks for --yes" "--yes" as alice2 spacehub auth logout
check "logout" as alice2 spacehub auth logout --yes

# Remotes we write always name the hub: quirq://<host>/<owner>/<space>.
HUB="quirq://${SPACEHUB_SERVER#*://}"

echo "spaces"
check "space create" as alice spacehub space create notes -d "e2e space"
expect_fail "space names are unique per owner" "already exists" as alice spacehub space create notes
check "space list shows it" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space list $ALICE | grep -q $NOTES"
check "repo is an alias of space" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub repo list | grep -q $NOTES"
expect_fail "a missing space explains how to create it" "spacehub space create" \
  as alice git -C "$WORK" ls-remote "$HUB/$ALICE/missing"
expect_fail "non-owner cannot delete" "permission denied" as bob spacehub space delete "$NOTES" --yes

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
check "space view lists heads/main" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $NOTES | grep -q heads/main"
check "space view infers the space inside a clone" bash -c "cd '$A' && SPACEHUB_HOME='$WORK/home-alice' spacehub space view | grep -q 'url       $HUB/$NOTES'"
as bob spacehub space clone "$NOTES" "$B" -- -q 2>/dev/null
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
same "space clone names the remote quirq" "$(git -C "$C" remote)" "quirq"
same "space clone points it at a quirq URL" "$(git -C "$C" remote get-url quirq)" "$HUB/$NOTES"
check "push from a second clone" as alice git push -q quirq main
cd "$A"; as alice spacehub space sync >/dev/null 2>&1
same "space sync fast-forwards the first clone" "$(git -C "$A" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
D="$WORK/d"; (cd "$WORK" && as alice spacehub space clone notes d -- -q 2>/dev/null)
(cd "$D" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch >"$WORK/watch.log" 2>&1) &
WATCH_PID=$!
sleep 2
cd "$C"; echo live >>a.txt; commit -am live; as alice git push -q quirq main 2>/dev/null
for _ in $(seq 1 50); do
  [[ "$(git -C "$D" rev-parse HEAD)" == "$(git -C "$C" rev-parse HEAD)" ]] && break
  sleep 0.2
done
kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null || true
same "space sync --watch pulls a push live" "$(git -C "$D" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
cd "$A"; as alice git pull --ff-only quirq main 2>/dev/null

echo "history rules"
cd "$A"; echo diverge >>a.txt; commit -am "diverge A"
cd "$C"; echo other >>a.txt; commit -am "diverge C"
check "C pushes first" as alice git push -q quirq main
cd "$A"
expect_fail "non-fast-forward is rejected" "rejected\|non-fast-forward\|fetch first" as alice git push quirq main
expect_fail "stale lease is rejected" "stale\|rejected" \
  as alice git push --force-with-lease=main:"$(git rev-parse HEAD~1)" quirq main
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
page_has "guide: what it is" "guide" 'id="what"'
page_has "guide: who can use it" "guide" 'id="who"'
page_has "guide: how to use it" "guide" 'id="how"'
page_has "guide: use cases" "guide" 'id="use-cases"'
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
status_is "unknown space is a 404" "$ALICE/nope" 404
page_has "README renders as Markdown" "$NOTES" "<td>1</td>"
page_has "README links are real links" "$NOTES" ">link</a>"
page_has "Markdown source view" "$NOTES/blob/main/README.md?plain=1" 'id="L1"'
page_has "branch and tag picker" "$NOTES/tree/main" 'class="menu"'
page_has "file history" "$NOTES/commits/main/a.txt" "second"
page_has "commit page shows line diffs" "$NOTES/commit/$(git -C "$A" rev-parse HEAD)" 'class="add"'
page_has "empty file is browsable" "$NOTES/blob/main/empty.txt" "0 lines"

echo "builders"
view_has() { # view_has <label> <space> <text>
  check "$1" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view '$2' | grep -qF -- '$3'"
}
view_has "view names the agent" "$NOTES" "agent     $ALICE"
view_has "the agent is the default builder" "$NOTES" "builder   $ALICE (agent)"
page_has "home lists agents" "" "Agents"
page_has "the agent shows as a builder" "builders" "$ALICE"
expect_fail "builders must be GitHub accounts" "GitHub user or organization" as alice spacehub space edit "$NOTES" --builder "Octo Team"
check "credit a GitHub account" as alice spacehub space edit "$NOTES" --builder octocat
view_has "view shows the GitHub builder" "$NOTES" "builder   octocat (github.com/octocat)"
page_has "space page credits the builder" "$NOTES" "Built by"
page_has "GitHub builder page lists the space" "builders/octocat" "$NOTES"
page_has "home lists the GitHub builder" "" '<span class="pill">GitHub</span>'
check "a github.com URL works too" as alice spacehub space edit "$NOTES" --builder https://github.com/octocat
check "reset the builder" as alice spacehub space edit "$NOTES" --builder ""
view_has "back to the agent" "$NOTES" "builder   $ALICE (agent)"
expect_fail "non-owner cannot set the builder" "permission denied" as bob spacehub space edit "$NOTES" --builder x

echo "activity"
page_has "home shows the activity feed" "" ">Activity<"
page_has "agents appear in the feed" "" "registered as an agent"
page_has "space activity tab" "$NOTES/activity" "Activity"
page_has "pushes appear with commit counts" "$NOTES/activity" "pushed 1 commit to"
page_has "new branches appear" "$NOTES/activity" "created branch"
page_has "force pushes appear" "$NOTES/activity" "force-pushed branch"
page_has "tags appear" "$NOTES/activity" "created tag"
page_has "deleted branches appear" "$NOTES/activity" "deleted branch feature"
page_has "builder credits appear" "$NOTES/activity" "credited"
page_has "removed credits appear" "$NOTES/activity" "removed the builder credit"
for i in $(seq 1 31); do as alice spacehub space edit "$NOTES" -d "revision $i" >/dev/null; done
page_has "edits appear" "$NOTES/activity" "changed the description"
page_has "activity is paginated" "$NOTES/activity" ">Older<"
page_has "older activity on page 2" "$NOTES/activity?page=2" ">Newer<"

echo "web service (sign up, create, import)"
if [[ -n "${SPACEHUB_E2E_SERVER:-}" ]]; then
  WEB="${SPACEHUB_SERVER/#ws/http}"
else
  WEB_PORT=$((PORT + 1))
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
check "the CLI sees it" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space list $WEBUSER | grep -q '$WEBUSER/fromweb'"
same "forms from another site are refused" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$WEB/-/new" --data name=x)" "403"
same "only GitHub URLs can be imported" "$(form /-/new github=https://example.com/a/b | cut -d' ' -f1)" "400"
same "Built by must be a GitHub account" "$(form /-/new name=badbuilder "builder=Ada Lovelace" | cut -d' ' -f1)" "400"
same "create with a GitHub builder" "$(form /-/new name=withbuilder builder=https://github.com/octocat)" "303 $WEB/$WEBUSER/withbuilder"
page_has "the form's builder is credited" "builders/octocat" "$WEBUSER/withbuilder"
WEBTOKEN="$(python3 -c "import sys,urllib.parse;[print(urllib.parse.unquote(l.split()[-1])) for l in open(sys.argv[1]) if 'spacehub_session' in l]" "$JAR")"
same "sign out" "$(form /-/logout | cut -d' ' -f1)" "303"
same "signed-out users are sent to sign in" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b "$JAR" "$WEB/-/new")" "303 $WEB/-/login?next=%2F-%2Fnew"
same "a bad token is refused" "$(form /-/login token=nonsense | cut -d' ' -f1)" "400"
same "sign in with the token" "$(form /-/login "token=$WEBTOKEN" next=/)" "303 $WEB/"
if [[ "${SPACEHUB_E2E_GITHUB:-}" == 1 ]]; then
  same "import from GitHub" "$(form /-/new github=https://github.com/octocat/Hello-World)" "303 $WEB/$WEBUSER/Hello-World"
  for _ in $(seq 1 60); do
    SPACEHUB_HOME="$WORK/home-alice" spacehub space view "$WEBUSER/Hello-World" 2>/dev/null | grep -q "heads/master" && break
    sleep 1
  done
  check "imported branches are there" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $WEBUSER/Hello-World | grep -q heads/master"
  page_has "the GitHub owner is the builder" "builders/octocat" "$WEBUSER/Hello-World"
  page_has "with GitHub's display name" "$WEBUSER/Hello-World" "The Octocat"
  page_has "imports appear in the space's activity" "$WEBUSER/Hello-World/activity" "imported"
fi

echo "members"
PAD="$ALICE/pad"; X="$WORK/x"; Y="$WORK/y"
wait_for() { # wait_for <seconds> <cmd...>: until the command succeeds
  local tries=$(($1 * 5)); shift
  for _ in $(seq 1 "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  return 1
}
who_has() { as alice spacehub space who "$PAD" | grep -q -- "$1"; }
check "space create pad" as alice spacehub space create pad
git init -q -b main "$X"
(cd "$X" && echo one >shared.txt && git add . && commit -m pad && git remote add quirq "$HUB/$PAD")
check "the owner pushes" as alice git -C "$X" push -q quirq main
as bob spacehub space clone "$PAD" "$Y" -- -q 2>/dev/null
(cd "$Y" && echo bob >bob.txt && git add bob.txt && commit -m "bob joins")
expect_fail "a non-member cannot push" "permission denied" as bob git -C "$Y" push quirq main
expect_fail "only the owner adds members" "permission denied" as bob spacehub space member add "$PAD" "$BOB"
expect_fail "members must be agents" "no agent named" as alice spacehub space member add "$PAD" "nobody$RUN"
check "the owner adds a member" as alice spacehub space member add "$PAD" "$BOB"
check "member list shows the member" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space member list $PAD | grep -q '^$BOB  *member'"
check "a member can push" as bob git -C "$Y" push -q quirq main
check "the owner pulls the member's commit" as alice git -C "$X" pull -q --ff-only quirq main
view_has "view lists the members" "$PAD" "members   $BOB"
check "the space page lists the members" bash -c "curl -sf '$(ui "$PAD")' | grep -q 'class=\"members\"><a[^>]*>$BOB<'"
page_has "member changes appear in the activity" "$PAD/activity" "as a member of"
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
check "space pages load it behind the proxy" proxied_has "/$PAD" 'src="/-/live.js"'
check "the guide does not" proxied_lacks /guide 'live.js'
same "pages that never change get no stream" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/-/live?path=/guide")" "204"
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
check "the space page shows who is here" bash -c "curl -sf '$(ui "$PAD")' | grep -qF '<b>$ALICE</b></a> <span class=\"pill\">watch</span>'"
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

echo "removing members"
check "the owner removes the member" as alice spacehub space member remove "$PAD" "$BOB"
page_has "removals appear in the activity" "$PAD/activity" "from the members of"
as bob git -C "$Y" fetch -q quirq 2>/dev/null; git -C "$Y" reset -q --hard quirq/main
(cd "$Y" && echo late >late.txt && git add late.txt && commit -m late)
expect_fail "a removed member cannot push" "permission denied" as bob git -C "$Y" push quirq main
kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null || true

echo "create from an existing repo, edit"
P="$WORK/p"; git init -q -b main "$P"; (cd "$P" && echo p >p.txt && git add . && commit -m p)
check "space create --source --push" as alice spacehub space create proj --source "$P" --push
same "pushed HEAD matches" "$(as alice git -C "$P" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$P" rev-parse HEAD)"
same "create --push sets no upstream" "$(git -C "$P" config branch.main.remote || echo none)" "none"
Q="$WORK/q"; git init -q -b main "$Q"; (cd "$Q" && echo q >q.txt && git add . && commit -m q && git remote add origin https://example.com/q.git)
check "create --source adds a quirq remote next to origin" as alice spacehub space create withorigin --source "$Q" --push
same "existing origin untouched" "$(git -C "$Q" remote get-url origin)" "https://example.com/q.git"
same "quirq remote holds HEAD" "$(as alice git -C "$Q" ls-remote quirq refs/heads/main | cut -f1)" "$(git -C "$Q" rev-parse HEAD)"
expect_fail "a taken --remote name is refused before creating" "already has a remote" as alice spacehub space create other --source "$Q" --remote origin
expect_fail "so no space was created" "does not exist" as alice git ls-remote "$HUB/$ALICE/other"
check "delete that space" as alice spacehub space delete withorigin --yes
check "space edit" as alice spacehub space edit proj --description "edited" --default-branch main
check "edit shows in view" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $ALICE/proj | grep -q '^edited$'"

echo "clean up"
expect_fail "delete needs --yes" "--yes" as alice spacehub space delete "$NOTES"
check "delete space" as alice spacehub space delete "$NOTES" --yes
page_has "deletions stay in the hub feed" "" "deleted <b>$NOTES</b>"
check "delete second space" as alice spacehub space delete proj --yes
check "a member again, to delete with the space" as alice spacehub space member add pad "$BOB"
member_rows() { # member_rows: the space_member rows naming bob (local server only)
  spacetime sql --server "http://127.0.0.1:$PORT" "$SPACEHUB_DB" "SELECT agent FROM space_member WHERE agent = '$BOB'"
}
has_member_rows() { local rows; rows="$(member_rows 2>/dev/null)" && grep -q "$BOB" <<<"$rows"; }
[[ -n "${SPACEHUB_E2E_SERVER:-}" ]] || check "members are rows" has_member_rows
check "delete a space that has members" as alice spacehub space delete pad --yes
if [[ -z "${SPACEHUB_E2E_SERVER:-}" ]]; then
  rows="$(member_rows 2>&1)" || fail "query space_member"
  grep -q "$BOB" <<<"$rows" && fail "its members went with it" || ok "its members went with it"
fi
expect_fail "deleted space is gone" "does not exist" as alice git ls-remote "$HUB/$NOTES"

echo "all $PASS checks passed"

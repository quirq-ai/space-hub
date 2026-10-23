#!/usr/bin/env bash
# End-to-end test: starts a throwaway SpacetimeDB on a spare port, publishes
# the module, then drives the spacehub CLI and real git through
# git-remote-spacehub.
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
PASS=0

cleanup() {
  local status=$?
  # Best effort from here: a kill or wait "failing" must not change the result.
  set +e
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

echo "spaces"
check "space create" as alice spacehub space create notes -d "e2e space"
expect_fail "space names are unique per owner" "already exists" as alice spacehub space create notes
check "space list shows it" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space list $ALICE | grep -q $NOTES"
check "repo is an alias of space" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub repo list | grep -q $NOTES"
expect_fail "a missing space explains how to create it" "spacehub space create" \
  as alice git -C "$WORK" ls-remote "spacehub://$ALICE/missing"
expect_fail "non-owner cannot delete" "permission denied" as bob spacehub space delete "$NOTES" --yes

echo "first push and clone"
A="$WORK/a"; B="$WORK/b"
git init -q -b main "$A"
cd "$A"
echo hello >a.txt; mkdir -p d/e; echo deep >d/e/b.txt; printf '\x00\x01binary' >bin.dat; : >empty.txt
printf '# Notes\n\nSome *notes* and a [link](d/e/b.txt).\n\n| key | value |\n|-----|-------|\n| a   | 1     |\n' >README.md
git add . && commit -m first
echo two >>a.txt && commit -am second
git remote add spacehub "spacehub://$NOTES"
as alice git push -q -u spacehub main 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "first push"; }
ok "push to an empty space"
check "space view lists heads/main" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $NOTES | grep -q heads/main"
check "space view infers the space inside a clone" bash -c "cd '$A' && SPACEHUB_HOME='$WORK/home-alice' spacehub space view | grep -q 'url       spacehub://$NOTES'"
as bob spacehub space clone "$NOTES" "$B" -- -q 2>/dev/null
same "clone matches (anyone can read)" "$(git -C "$B" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
same "clone checks out the default branch" "$(git -C "$B" symbolic-ref HEAD)" "refs/heads/main"
check "binary content round-trips" cmp -s "$A/bin.dat" "$B/bin.dat"
check "clone passes git fsck" git -C "$B" fsck --strict

echo "permissions"
cd "$B"; echo bob >>a.txt; commit -am "bob edit"
expect_fail "non-owner cannot push" "permission denied" as bob git push spacehub main

echo "sync between two working copies"
C="$WORK/c"
(cd "$WORK" && as alice spacehub space clone notes c -- -q 2>/dev/null)
cd "$C"; echo three >>a.txt; commit -am third
same "space clone names the remote spacehub" "$(git -C "$C" remote)" "spacehub"
check "push from a second clone" as alice git push -q spacehub main
cd "$A"; as alice spacehub space sync >/dev/null 2>&1
same "space sync fast-forwards the first clone" "$(git -C "$A" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
D="$WORK/d"; (cd "$WORK" && as alice spacehub space clone notes d -- -q 2>/dev/null)
(cd "$D" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch >"$WORK/watch.log" 2>&1) &
WATCH_PID=$!
sleep 2
cd "$C"; echo live >>a.txt; commit -am live; as alice git push -q spacehub main 2>/dev/null
for _ in $(seq 1 50); do
  [[ "$(git -C "$D" rev-parse HEAD)" == "$(git -C "$C" rev-parse HEAD)" ]] && break
  sleep 0.2
done
kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null || true
same "space sync --watch pulls a push live" "$(git -C "$D" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
cd "$A"; as alice git pull -q --ff-only spacehub main 2>/dev/null

echo "history rules"
cd "$A"; echo diverge >>a.txt; commit -am "diverge A"
cd "$C"; echo other >>a.txt; commit -am "diverge C"
check "C pushes first" as alice git push -q spacehub main
cd "$A"
expect_fail "non-fast-forward is rejected" "rejected\|non-fast-forward\|fetch first" as alice git push spacehub main
expect_fail "stale lease is rejected" "stale\|rejected" \
  as alice git push --force-with-lease=main:"$(git rev-parse HEAD~1)" spacehub main
check "force push overwrites" as alice git push -q --force spacehub main
same "remote now holds A's commit" "$(as alice git ls-remote spacehub refs/heads/main | cut -f1)" "$(git rev-parse HEAD)"

echo "branches, merges and tags"
git checkout -q -b feature; echo f >f.txt; git add f.txt; commit -m feature
git checkout -q main; echo m >m.txt; git add m.txt; commit -m "main work"
git merge -q --no-ff -m "merge feature" feature
check "push a merge and a second branch" as alice git push -q spacehub main feature
git tag v1; git -c user.name=e2e -c user.email=e2e@example.com tag -a v2 -m "annotated"
check "push light and annotated tags" as alice git push -q spacehub v1 v2
expect_fail "moving an existing tag needs force" "already exists\|rejected" \
  bash -c "cd '$A' && git tag -f v1 HEAD~1 && SPACEHUB_HOME='$WORK/home-alice' git push spacehub v1"
check "delete a branch" as alice git push -q spacehub :feature
cd "$C"; as alice git fetch -q --tags spacehub 2>/dev/null
same "fetch brings the merge" "$(git rev-parse spacehub/main)" "$(git -C "$A" rev-parse main)"
same "annotated tag fetched as a tag object" "$(git cat-file -t v2)" "tag"
as alice git fetch -q --prune spacehub 2>/dev/null
check "pruned deleted branch" bash -c "! git rev-parse -q --verify refs/remotes/spacehub/feature"
git reset -q --hard spacehub/main  # C's own commit was force-pushed over

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
check "push 5 MiB blob (chunked) and 1500 files" as alice git push -q spacehub main
cd "$C"
out="$(as alice git pull --ff-only spacehub main 2>&1)" || { echo "$out" >&2; fail "pull large push"; }
check "chunked blob round-trips byte for byte" cmp -s "$A/big.bin" "$C/big.bin"
same "multi-window fetch is complete" "$(git rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
check "fsck after large fetch" git fsck --strict
cd "$A"; echo tiny >tiny.txt; git add tiny.txt; commit -m tiny
as alice git push -q spacehub main 2>/dev/null
cd "$C"
out="$(as alice git fetch spacehub 2>&1)" || { echo "$out" >&2; fail "incremental fetch"; }
grep -q "received 3 objects" <<<"$out" && ok "incremental fetch only downloads new objects" \
  || { echo "$out" >&2; fail "incremental fetch"; }
rm -rf "$C/.git/spacehub"
echo again >>"$A/tiny.txt"; git -C "$A" add tiny.txt; (cd "$A" && commit -m again && as alice git push -q spacehub main 2>/dev/null)
as alice git fetch -q spacehub 2>/dev/null
same "fetch without a fetch record still works" "$(git rev-parse spacehub/main)" "$(git -C "$A" rev-parse HEAD)"

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

echo "create from an existing repo, edit"
P="$WORK/p"; git init -q -b main "$P"; (cd "$P" && echo p >p.txt && git add . && commit -m p)
check "space create --source --push" as alice spacehub space create proj --source "$P" --push
same "pushed HEAD matches" "$(as alice git -C "$P" ls-remote spacehub refs/heads/main | cut -f1)" "$(git -C "$P" rev-parse HEAD)"
Q="$WORK/q"; git init -q -b main "$Q"; (cd "$Q" && echo q >q.txt && git add . && commit -m q && git remote add origin https://example.com/q.git)
check "create --source adds a spacehub remote next to origin" as alice spacehub space create withorigin --source "$Q" --push
same "existing origin untouched" "$(git -C "$Q" remote get-url origin)" "https://example.com/q.git"
same "spacehub remote holds HEAD" "$(as alice git -C "$Q" ls-remote spacehub refs/heads/main | cut -f1)" "$(git -C "$Q" rev-parse HEAD)"
expect_fail "a taken --remote name is refused before creating" "already has a remote" as alice spacehub space create other --source "$Q" --remote origin
expect_fail "so no space was created" "does not exist" as alice git ls-remote "spacehub://$ALICE/other"
check "delete that space" as alice spacehub space delete withorigin --yes
check "space edit" as alice spacehub space edit proj --description "edited" --default-branch main
check "edit shows in view" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $ALICE/proj | grep -q '^edited$'"

echo "clean up"
expect_fail "delete needs --yes" "--yes" as alice spacehub space delete "$NOTES"
check "delete space" as alice spacehub space delete "$NOTES" --yes
page_has "deletions stay in the hub feed" "" "deleted <b>$NOTES</b>"
check "delete second space" as alice spacehub space delete proj --yes
expect_fail "deleted space is gone" "does not exist" as alice git ls-remote "spacehub://$NOTES"

echo "all $PASS checks passed"

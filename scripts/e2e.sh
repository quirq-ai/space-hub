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
PASS=0

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK"
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
  ok "module published"
fi

# Unique names so the suite can run repeatedly against a long-lived server.
RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
ALICE="alice$RUN"; BOB="bob$RUN"; NOTES="$ALICE/notes"

echo "auth"
check "auth login creates the username" as alice spacehub auth login --username "$ALICE"
check "a second user" as bob spacehub auth login --username "$BOB"
expect_fail "usernames are unique" "taken" as carol spacehub auth login --username "$ALICE"
check "auth status shows the account" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub auth status | grep -q 'account   $ALICE'"
check "same identity on another machine (token + --with-token)" bash -c \
  "SPACEHUB_HOME='$WORK/home-alice' spacehub auth token | SPACEHUB_HOME='$WORK/home-alice2' spacehub auth login --with-token | grep -q 'as $ALICE'"
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
echo hello >a.txt; mkdir -p d/e; echo deep >d/e/b.txt; printf '\x00\x01binary' >bin.dat
git add . && commit -m first
echo two >>a.txt && commit -am second
git remote add origin "spacehub://$NOTES"
as alice git push -q -u origin main 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "first push"; }
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
expect_fail "non-owner cannot push" "permission denied" as bob git push origin main

echo "sync between two working copies"
C="$WORK/c"
(cd "$WORK" && as alice spacehub space clone notes c -- -q 2>/dev/null)
cd "$C"; echo three >>a.txt; commit -am third
check "push from a second clone" as alice git push -q origin main
cd "$A"; as alice spacehub space sync >/dev/null 2>&1
same "space sync fast-forwards the first clone" "$(git -C "$A" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
D="$WORK/d"; (cd "$WORK" && as alice spacehub space clone notes d -- -q 2>/dev/null)
(cd "$D" && SPACEHUB_HOME="$WORK/home-alice" exec spacehub space sync --watch >"$WORK/watch.log" 2>&1) &
WATCH_PID=$!
sleep 2
cd "$C"; echo live >>a.txt; commit -am live; as alice git push -q origin main 2>/dev/null
for _ in $(seq 1 50); do
  [[ "$(git -C "$D" rev-parse HEAD)" == "$(git -C "$C" rev-parse HEAD)" ]] && break
  sleep 0.2
done
kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null || true
same "space sync --watch pulls a push live" "$(git -C "$D" rev-parse HEAD)" "$(git -C "$C" rev-parse HEAD)"
cd "$A"; as alice git pull -q --ff-only origin main 2>/dev/null

echo "history rules"
cd "$A"; echo diverge >>a.txt; commit -am "diverge A"
cd "$C"; echo other >>a.txt; commit -am "diverge C"
check "C pushes first" as alice git push -q origin main
cd "$A"
expect_fail "non-fast-forward is rejected" "rejected\|non-fast-forward\|fetch first" as alice git push origin main
expect_fail "stale lease is rejected" "stale\|rejected" \
  as alice git push --force-with-lease=main:"$(git rev-parse HEAD~1)" origin main
check "force push overwrites" as alice git push -q --force origin main
same "remote now holds A's commit" "$(as alice git ls-remote origin refs/heads/main | cut -f1)" "$(git rev-parse HEAD)"

echo "branches, merges and tags"
git checkout -q -b feature; echo f >f.txt; git add f.txt; commit -m feature
git checkout -q main; echo m >m.txt; git add m.txt; commit -m "main work"
git merge -q --no-ff -m "merge feature" feature
check "push a merge and a second branch" as alice git push -q origin main feature
git tag v1; git -c user.name=e2e -c user.email=e2e@example.com tag -a v2 -m "annotated"
check "push light and annotated tags" as alice git push -q origin v1 v2
expect_fail "moving an existing tag needs force" "already exists\|rejected" \
  bash -c "cd '$A' && git tag -f v1 HEAD~1 && SPACEHUB_HOME='$WORK/home-alice' git push origin v1"
check "delete a branch" as alice git push -q origin :feature
cd "$C"; as alice git fetch -q --tags origin 2>/dev/null
same "fetch brings the merge" "$(git rev-parse origin/main)" "$(git -C "$A" rev-parse main)"
same "annotated tag fetched as a tag object" "$(git cat-file -t v2)" "tag"
as alice git fetch -q --prune origin 2>/dev/null
check "pruned deleted branch" bash -c "! git rev-parse -q --verify refs/remotes/origin/feature"
git reset -q --hard origin/main  # C's own commit was force-pushed over

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
check "push 5 MiB blob (chunked) and 1500 files" as alice git push -q origin main
cd "$C"
out="$(as alice git pull --ff-only origin main 2>&1)" || { echo "$out" >&2; fail "pull large push"; }
check "chunked blob round-trips byte for byte" cmp -s "$A/big.bin" "$C/big.bin"
same "multi-window fetch is complete" "$(git rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)"
check "fsck after large fetch" git fsck --strict
cd "$A"; echo tiny >tiny.txt; git add tiny.txt; commit -m tiny
as alice git push -q origin main 2>/dev/null
cd "$C"
out="$(as alice git fetch origin 2>&1)" || { echo "$out" >&2; fail "incremental fetch"; }
grep -q "received 3 objects" <<<"$out" && ok "incremental fetch only downloads new objects" \
  || { echo "$out" >&2; fail "incremental fetch"; }
rm -rf "$C/.git/spacehub"
echo again >>"$A/tiny.txt"; git -C "$A" add tiny.txt; (cd "$A" && commit -m again && as alice git push -q origin main 2>/dev/null)
as alice git fetch -q origin 2>/dev/null
same "fetch without a fetch record still works" "$(git rev-parse origin/main)" "$(git -C "$A" rev-parse HEAD)"

echo "create from an existing repo, edit"
P="$WORK/p"; git init -q -b main "$P"; (cd "$P" && echo p >p.txt && git add . && commit -m p)
check "space create --source --push" as alice spacehub space create proj --source "$P" --push
same "pushed HEAD matches" "$(as alice git -C "$P" ls-remote origin refs/heads/main | cut -f1)" "$(git -C "$P" rev-parse HEAD)"
check "space edit" as alice spacehub space edit proj --description "edited" --default-branch main
check "edit shows in view" bash -c "SPACEHUB_HOME='$WORK/home-alice' spacehub space view $ALICE/proj | grep -q '^edited$'"

echo "clean up"
expect_fail "delete needs --yes" "--yes" as alice spacehub space delete "$NOTES"
check "delete space" as alice spacehub space delete "$NOTES" --yes
check "delete second space" as alice spacehub space delete proj --yes
expect_fail "deleted space is gone" "does not exist" as alice git ls-remote "spacehub://$NOTES"

echo "all $PASS checks passed"

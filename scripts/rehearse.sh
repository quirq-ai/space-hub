#!/usr/bin/env bash
# Rehearse a deploy on a copy of a hub's data before it reaches the real hub.
#
# Copies a backup of a hub's /data (never touching the backup itself), opens
# the copy as it is and records what it holds, deploys the new server image
# (or publishes a module) onto the copy, records again, and compares:
#
#   - every table's row count, and a checksum of its rows (all tables but
#     git_object and object_chunk, which are counted per project instead);
#   - for every project: its refs, git objects and object chunks, and a
#     checksum of its refs (name and commit).
#
# Tables the deploy adds are listed, not counted as a difference (a new image
# may add tables, never change old ones). Exit 0: identical; 1: a difference;
# 2: the rehearsal could not run, or the deploy itself failed.
#
#   scripts/rehearse.sh --backup <dir> --image <image> [-e KEY=VALUE]...
#   scripts/rehearse.sh --backup <dir> --module <module dir or bundle.js>
#
# <dir> is a backup (a vault's snapshots/<id>, or a folder with hub.json and
# data/ that `spacehub subhub restore` made) or a hub data folder itself (a
# copy of /data). See README, "Rehearse a deploy".
set -Eeuo pipefail

usage() {
  sed -n '2,/^set -Eeuo/p' "$0" | sed '$d; s/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --backup <dir>      the backup to rehearse on (read only; it is copied)
  --image <image>     deploy this server image with Docker (its own entrypoint)
  -e, --env KEY=VALUE settings for the image, as on the hub (repeatable); give
                      the hub's SPACEHUB_ACCOUNTS, since every start sets it
  --module <path>     instead of Docker: publish this module (a folder or a
                      built bundle.js) with the local spacetime CLI, then call
                      claim_admin and set_accounts as the image's start does
  --accounts <mode>   with --module: what set_accounts is given (default github)
  --port <n>          with --module: the local SpacetimeDB's port (default 3293)
  --db <name>         the database (default spacehub)
  --work <dir>        where the copy goes (default: a new folder in $TMPDIR)
  --keep              keep the copy and the records afterwards
EOF
}

BACKUP="" IMAGE="" MODULE="" DB="spacehub" PORT=3293 ACCOUNTS="github" WORK="" KEEP=0
ENVS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    -e | --env) ENVS+=(-e "${2:?}"); shift 2 ;;
    --module) MODULE="${2:?}"; shift 2 ;;
    --accounts) ACCOUNTS="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --db) DB="${2:?}"; shift 2 ;;
    --work) WORK="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "rehearse: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "rehearse: $*" >&2; exit 2; }
say() { echo "rehearse: $*"; }
[[ -n "$BACKUP" ]] || die "--backup is required (see --help)"
[[ -n "$IMAGE" || -n "$MODULE" ]] || die "give --image or --module"
[[ -z "$IMAGE" || -z "$MODULE" ]] || die "give --image or --module, not both"
[[ -d "$BACKUP" ]] || die "no folder $BACKUP"
BACKUP="$(cd "$BACKUP" && pwd -P)"

# A backup holds hub.json beside data/, the hub's data folder (in a vault,
# under payload/); otherwise the folder is taken to be a data folder (it has
# SpacetimeDB's own data/).
if [[ -f "$BACKUP/payload/hub.json" && -d "$BACKUP/payload/data" ]]; then SOURCE="$BACKUP/payload/data"
elif [[ -f "$BACKUP/hub.json" && -d "$BACKUP/data" ]]; then SOURCE="$BACKUP/data"
else SOURCE="$BACKUP"; fi
[[ -d "$SOURCE/data" ]] || die "$SOURCE is not a hub data folder (no data/ in it)"
[[ -f "$SOURCE/config/cli.toml" ]] || die "$SOURCE has no config/cli.toml: the database owner's identity is needed to read every table"

if [[ -n "$IMAGE" ]]; then
  command -v docker >/dev/null || die "--image needs docker"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE here (docker pull or build it first)"
else
  command -v spacetime >/dev/null || die "--module needs the spacetime CLI on PATH"
  [[ -e "$MODULE" ]] || die "no module at $MODULE"
  MODULE="$(cd "$(dirname "$MODULE")" && pwd -P)/$(basename "$MODULE")"
  if curl -sf "http://127.0.0.1:$PORT/v1/ping" >/dev/null 2>&1; then die "port $PORT is in use; pick another with --port"; fi
fi

if [[ -z "$WORK" ]]; then WORK="$(mktemp -d "${TMPDIR:-/tmp}/spacehub-rehearse.XXXXXX")"; else mkdir -p "$WORK"; fi
WORK="$(cd "$WORK" && pwd -P)"
[[ -z "$(ls -A "$WORK")" ]] || die "$WORK is not empty"
case "$WORK/" in "$SOURCE/"*) die "the work folder must not be inside the backup" ;; esac
COPY="$WORK/data"
CONTAINER="spacehub-rehearse-$$"
SERVER_PID=""

cleanup() {
  local status=$?
  trap - ERR INT TERM
  set +e
  [[ -n "$IMAGE" ]] && docker rm -f "$CONTAINER" >/dev/null 2>&1
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  if [[ "$KEEP" = 1 ]]; then
    say "kept the copy and the records in $WORK"
  elif [[ -n "$IMAGE" && -d "$COPY" ]]; then
    # The container made the copy its own (uid 1000); remove it the same way.
    docker run --rm --network none --user 0 -v "$WORK:/work" --entrypoint rm "$IMAGE" -rf /work/data >/dev/null 2>&1
    rm -rf "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT
# Anything failing that is not a finding stops the rehearsal with 2.
trap 'exit 2' INT TERM ERR

say "copying $SOURCE to $COPY"
mkdir "$COPY"
cp -a "$SOURCE/." "$COPY/"
# The copy is SpacetimeDB's to write (a backup may be read only), with no
# stale pid file from the hub.
chmod -R u+w "$COPY"
rm -f "$COPY/data/spacetime.pid"

# --- how SQL reaches the copy ------------------------------------------------
# Every query runs as the database's owner (the identity in the copy's
# config/cli.toml), so private tables are read too. No token leaves the copy.
sql() { # sql <query>: SpacetimeDB's text table
  local err="$WORK/sql.err"
  if [[ -n "$IMAGE" ]]; then
    docker exec -u spacetime "$CONTAINER" spacetime --root-dir /data sql --server http://127.0.0.1:3001 "$DB" "$1" 2>"$err"
  else
    spacetime --root-dir "$COPY" sql --server "http://127.0.0.1:$PORT" "$DB" "$1" 2>"$err"
  fi || { echo "rehearse: this query failed: $1" >&2; grep -v WARNING "$err" >&2; return 2; }
}
# The rows of a text table: drop the header line and its ----+---- rule.
rows() { awk 'ruled { print; next } /^-+(\+-+)*$/ { ruled = 1 }'; }
# Its cells, |-separated, trimmed and unquoted.
fields() { rows | awk -F'|' -v OFS='|' '{ for (i = 1; i <= NF; i++) { gsub(/^ +| +$/, "", $i); gsub(/^"|"$/, "", $i) } print }'; }

record() { # record <file>: what the copy holds now, one sorted line per table and project
  local out="$1" tables t n sum id name
  tables="$(sql "SELECT table_name FROM st_table" | fields | grep -v '^st_' | LC_ALL=C sort)"
  [[ -n "$tables" ]] || { echo "rehearse: the database has no tables" >&2; return 1; }
  : >"$out"
  for t in $tables; do
    n="$(sql "SELECT COUNT(*) AS n FROM $t" | fields | head -n 1)"
    case "$t" in
      git_object | object_chunk) sum="-" ;;  # their bytes are big: counted per project below
      *) sum="$(sql "SELECT * FROM $t" | rows | LC_ALL=C sort | sha256sum | cut -c1-16)" ;;
    esac
    printf 'table   %-28s rows %-8s rows-sum %s\n' "$t" "$n" "$sum" >>"$out"
  done
  # Per project (by name): its refs and what they point at, its git objects
  # and their chunks. Each list is read once and counted here.
  sql "SELECT id, full_name FROM project" | fields >"$out.names"
  sql "SELECT project_id, name, oid FROM git_ref" | fields >"$out.refs"
  sql "SELECT project_id FROM git_object" | fields >"$out.objects"
  sql "SELECT project_id FROM object_chunk" | fields >"$out.chunks"
  while IFS='|' read -r id name; do
    sum="$(awk -F'|' -v id="$id" '$1 == id { print $2 "=" $3 }' "$out.refs" | LC_ALL=C sort | sha256sum | cut -c1-16)"
    printf 'project %-28s refs %-6s objects %-8s chunks %-6s refs-sum %s\n' "$name" \
      "$(awk -F'|' -v id="$id" '$1 == id' "$out.refs" | wc -l)" \
      "$(grep -cx -- "$id" "$out.objects" || true)" \
      "$(grep -cx -- "$id" "$out.chunks" || true)" "$sum"
  done <"$out.names" | LC_ALL=C sort >>"$out"
  rm -f "$out.names" "$out.refs" "$out.objects" "$out.chunks"
}

# --- open the copy as it is ---------------------------------------------------
# Only SpacetimeDB, with nothing published or called: the backup's own module
# serves its own data. With --image, the image's SpacetimeDB opens it, as the
# image's start does (as uid 1000, with no network).
up() { # up: is the server process still there
  if [[ -n "$IMAGE" ]]; then [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == true ]]; else kill -0 "$SERVER_PID" 2>/dev/null; fi
}
wait_ping() { # wait_ping <check...>: until SpacetimeDB answers, for up to a minute
  local i
  for i in $(seq 1 300); do
    "$@" >/dev/null 2>&1 && return 0
    up || return 1
    sleep 0.2
  done
  return 1
}
if [[ -n "$IMAGE" ]]; then
  open_copy() {
    docker run -d --name "$CONTAINER" --network none --user 0 -v "$COPY:/data" --entrypoint sh "$IMAGE" -c \
      'chown -R spacetime:spacetime /data && exec setpriv --reuid=spacetime --regid=spacetime --init-groups env HOME=/home/spacetime spacetime --root-dir /data start --listen-addr 127.0.0.1:3001 --non-interactive' >/dev/null
    wait_ping docker exec "$CONTAINER" curl -sf http://127.0.0.1:3001/v1/ping \
      || { docker logs --tail 5 "$CONTAINER" >&2; die "SpacetimeDB did not start on the copy"; }
  }
  close_copy() { docker rm -f "$CONTAINER" >/dev/null; }
else
  open_copy() {
    spacetime --root-dir "$COPY" start --listen-addr "127.0.0.1:$PORT" --non-interactive >"$WORK/spacetime.log" 2>&1 &
    SERVER_PID=$!
    wait_ping curl -sf "http://127.0.0.1:$PORT/v1/ping" || { tail -n 5 "$WORK/spacetime.log" >&2; die "SpacetimeDB did not start on the copy"; }
  }
  close_copy() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
fi

say "opening the copy as it is"
open_copy
record "$WORK/before.txt"
close_copy
say "before: $(grep -c '^table' "$WORK/before.txt" || true) tables, $(grep -c '^project' "$WORK/before.txt" || true) projects"

# --- deploy onto the copy -----------------------------------------------------
if [[ -n "$IMAGE" ]]; then
  say "starting $IMAGE on the copy (its own start: publish, claim_admin, set_accounts)"
  # No network: the copy holds the real hub's tokens, and nothing on it may
  # reach GitHub, xo or runners. Later settings win, so the sync stays off.
  docker run -d --name "$CONTAINER" --network none -v "$COPY:/data" ${ENVS[@]+"${ENVS[@]}"} \
    -e SPACEHUB_GITHUB_SYNC_MINUTES=0 -e SPACEHUB_BACKUP_MINUTES=0 "$IMAGE" >/dev/null
  # (The log goes to a file first: grep -q on a pipe would cut docker logs off.)
  started() { docker logs "$CONTAINER" >"$WORK/hub.log" 2>&1; grep -q '^spacehub: serving database' "$WORK/hub.log"; }
  for _ in $(seq 1 600); do
    started && break
    if ! up; then
      grep -v ' DEBUG ' "$WORK/hub.log" | tail -n 30 >&2
      echo "rehearse: FAILED: the image stopped during its start on the copy (see above); the hub would not come up" >&2
      exit 2
    fi
    sleep 0.5
  done
  started || die "the image did not finish starting in 5 minutes"
else
  say "publishing $MODULE to the copy (as the owner, never --delete-data), then claim_admin and set_accounts"
  open_copy
  if [[ -d "$MODULE" ]]; then from=(--module-path "$MODULE"); else from=(--js-path "$MODULE"); fi
  if ! spacetime --root-dir "$COPY" publish --server "http://127.0.0.1:$PORT" "$DB" "${from[@]}" --yes >"$WORK/publish.log" 2>&1; then
    tail -n 30 "$WORK/publish.log" >&2
    echo "rehearse: FAILED: the publish was refused (see above); the hub would not start" >&2
    exit 2
  fi
  spacetime --root-dir "$COPY" call --server "http://127.0.0.1:$PORT" "$DB" claim_admin >"$WORK/call.log" 2>&1 \
    || { cat "$WORK/call.log" >&2; echo "rehearse: FAILED: claim_admin failed; the hub would not start" >&2; exit 2; }
  spacetime --root-dir "$COPY" call --server "http://127.0.0.1:$PORT" "$DB" set_accounts "\"$ACCOUNTS\"" >"$WORK/call.log" 2>&1 \
    || { cat "$WORK/call.log" >&2; echo "rehearse: FAILED: set_accounts failed; the hub would not start" >&2; exit 2; }
  # As the image's start does since project_access (a module from before it has no such reducer).
  if ! spacetime --root-dir "$COPY" call --server "http://127.0.0.1:$PORT" "$DB" rebuild_access >"$WORK/call.log" 2>&1; then
    if grep -qi 'no such reducer\|not found' "$WORK/call.log"; then say "this module has no rebuild_access (older than project_access)"
    else cat "$WORK/call.log" >&2; echo "rehearse: FAILED: rebuild_access failed; the hub would not start" >&2; exit 2; fi
  fi
fi
record "$WORK/after.txt"
close_copy

# --- compare ------------------------------------------------------------------
# A table only after the deploy is new: listed, not a difference.
added="$(awk 'NR == FNR { if ($1 == "table") seen[$2] = 1; next } $1 == "table" && !seen[$2]' "$WORK/before.txt" "$WORK/after.txt")"
if [[ -n "$added" ]]; then
  say "new tables (allowed):"
  echo "$added" | sed 's/^/  /'
fi
awk 'NR == FNR { if ($1 == "table") seen[$2] = 1; next } !($1 == "table" && !seen[$2])' \
  "$WORK/before.txt" "$WORK/after.txt" >"$WORK/after-old.txt"
if diff -u --label before "$WORK/before.txt" --label after "$WORK/after-old.txt" >"$WORK/diff.txt"; then
  say "identical: $(grep -c '^table' "$WORK/before.txt" || true) tables and $(grep -c '^project' "$WORK/before.txt" || true) projects hold the same rows, refs and objects after the deploy"
  exit 0
fi
echo "rehearse: DIFFERENT: the deploy changed existing data (- before, + after):"
tail -n +3 "$WORK/diff.txt" | grep '^[-+]' | sed 's/^/  /'
exit 1

#!/bin/sh
# Checks that a private hub lets nobody in without XO (docs/privatehub.md).
#
#   scripts/private-smoke.sh https://privatehub.example.com            strangers only
#   SPACEHUB_TOKEN=... scripts/private-smoke.sh https://privatehub...   also a signed-in builder
#
# SPACEHUB_TOKEN is an XO builder's hub token (spacehub auth token, after xo login).
# Prints one line per check and exits 1 if any check fails.
set -u
BASE="${1:?usage: private-smoke.sh <hub url, e.g. https://privatehub.example.com>}"
BASE="${BASE%/}"
fail=0

check() { # expected-status description curl-args...
  want="$1"; what="$2"; shift 2
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@")"
  case " $want " in
    *" $got "*) printf 'ok    %-52s %s\n' "$what" "$got" ;;
    *) printf 'FAIL  %-52s %s (want %s)\n' "$what" "$got" "$want"; fail=1 ;;
  esac
}

echo "strangers:"
check 200 "health" "$BASE/healthz"
check 200 "sign-in page" "$BASE/-/login"
check 200 "app stylesheet" "$BASE/-/app/shell.css"
check 303 "home page sends to sign-in" -H 'accept: text/html' "$BASE/"
check 303 "module page sends to sign-in" -H 'accept: text/html' "$BASE/-/guide"
check 303 "repo room sends to sign-in" -H 'accept: text/html' "$BASE/gh/octocat/hello-world"
check 401 "app API" "$BASE/-/api/view"
check 401 "websocket token" -X POST "$BASE/v1/identity/websocket-token"
check 401 "database websocket" "$BASE/v1/database/spacehub/subscribe"
check 401 "new identity" -X POST "$BASE/v1/identity"
check 401 "GitHub sign-in (CLI)" -X POST "$BASE/-/api/auth/github"
check 401 "xo API without its key" -X POST "$BASE/-/api/xo/v1/agents/user_x"
check "401 404" "gate itself" "$BASE/-/gate"

if [ -n "${SPACEHUB_TOKEN:-}" ]; then
  echo "signed in:"
  check 200 "home page" -H 'accept: text/html' -b "spacehub_session=$SPACEHUB_TOKEN" "$BASE/"
  check 200 "app API" -H "authorization: Bearer $SPACEHUB_TOKEN" "$BASE/-/api/me"
  check 200 "websocket token" -X POST -H "authorization: Bearer $SPACEHUB_TOKEN" "$BASE/v1/identity/websocket-token"
  check 404 "SQL stays closed" -X POST -H "authorization: Bearer $SPACEHUB_TOKEN" --data 'SELECT 1' "$BASE/v1/database/spacehub/sql"
fi
exit "$fail"

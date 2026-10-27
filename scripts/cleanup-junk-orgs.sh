#!/bin/bash
# Removes the empty orgs that xo made by mistake on hub.quirq.dev. Between xo 1ef9c04 and 82dac60,
# with a hub found by xo login, xo ran `spacehub space create NAME`, which makes an org since this
# repo's #5; xo 6e6d79b makes projects instead.
#
# It deletes only orgs that `spacehub space list` shows as kind org (team on older hubs) with 0
# projects and a description starting "xo:", only after you type y, and never a NAME for which
# you have a project ($me/NAME): `space delete NAME` deletes that project when NAME is not a space.
# Run it where you ran xo login (it uses the hub login spacehub keeps there): bash cleanup-junk-orgs.sh
(
  unset CDPATH SPACEHUB_TOKEN SPACEHUB_DB
  export SPACEHUB_SERVER=wss://hub.quirq.dev
  if ! command -v spacehub >/dev/null 2>&1; then
    echo "spacehub is not installed here; nothing was done"
    exit 1
  fi
  lock="${TMPDIR:-/tmp}/spacehub-cleanup-junk-orgs.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    echo "another run of this script is going ($lock exists; remove it if not); nothing was done"
    exit 1
  fi
  trap 'rmdir "$lock" 2>/dev/null' EXIT
  me=$(spacehub auth status 2>/dev/null | awk '$1 == "builder" && NF == 2 { print $2 }')
  if [ -z "$me" ]; then
    echo "spacehub is not logged in to hub.quirq.dev here (run xo login first); nothing was done"
    exit 1
  fi
  junk() {
    spacehub space list "$me" 2>/dev/null |
      awk '($2 == "org" || $2 == "team") && $3 == "0" && $4 == "projects" && $5 ~ /^xo:/ { print $1 }'
  }
  names=$(junk)
  if [ -z "$names" ]; then
    echo "No junk orgs for $me on hub.quirq.dev. Nothing to do."
    exit 0
  fi
  echo "Empty orgs made by xo for $me on hub.quirq.dev:"
  for n in $names; do echo "  $n"; done
  printf 'Delete these orgs? Type y exactly to delete, anything else to stop: '
  answer=
  read -r answer </dev/tty
  if [ "$answer" != "y" ]; then
    echo "Nothing was deleted."
    exit 0
  fi
  for n in $names; do
    # Right before each delete: still an empty xo-made org, and no project $me/NAME that
    # `space delete NAME` would delete instead if the org went away meanwhile.
    if ! junk | grep -qx -- "$n"; then
      echo "  skipped $n: no longer an empty xo-made org"
      continue
    fi
    if ! projects=$(spacehub project list "$me" 2>/dev/null); then
      echo "  skipped $n: could not list your projects to check it is safe"
      continue
    fi
    if printf '%s\n' "$projects" | awk '{ print $1 }' | grep -qx -- "$me/$n"; then
      echo "  skipped $n: you have a project $me/$n, which space delete could remove"
      continue
    fi
    spacehub space delete "$n" --yes || echo "  could not delete $n (see the line above)"
  done
  left=$(junk)
  if [ -z "$left" ]; then
    echo "Done: no junk orgs left for $me."
  else
    echo "Still there:"
    for n in $left; do echo "  $n"; done
  fi
)

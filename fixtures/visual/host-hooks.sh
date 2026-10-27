#!/bin/bash
# The fixture's host hooks. Usage: host-hooks.sh <name> <demo-dir> [args…]
case "$1" in
  release) : >"$2/flag"; echo "released in $2" ;;
  echo) shift 2; printf '%s|' "$@" ;;
  fail) echo "boom" >&2; exit 3 ;;
  *) echo "unknown hook $1" >&2; exit 2 ;;
esac

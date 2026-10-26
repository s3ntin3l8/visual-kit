#!/usr/bin/env bash
# Host side of visual-kit. The demo needs the host's toolchain, so it cannot run in the image:
# this script boots it, runs the image against it and tears it down again.
#
#   run.sh <landing|readme|audit|check> [--routes a,b] [--out DIR] [--base REF] [--slug S] [--fresh]
#
# Environment: VISUAL_KIT_IMAGE (required, set by the Makefile), VISUAL_CONFIG (default visual/scenes.json).
set -euo pipefail

die() { echo "visual-kit: $*" >&2; exit 1; }

MODE=${1:-}; shift || true
case "$MODE" in landing | readme | audit | check) ;; *) die "usage: run.sh <landing|readme|audit|check> [options]" ;; esac

ROUTES="" OUT="" BASE_REF="origin/main" SLUG="" FRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --routes) ROUTES=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --base) BASE_REF=$2; shift 2 ;;
    --slug) SLUG=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

IMAGE=${VISUAL_KIT_IMAGE:?VISUAL_KIT_IMAGE is not set}
ROOT=$(git rev-parse --show-toplevel)
CONFIG=${VISUAL_CONFIG:-visual/scenes.json}
cd "$ROOT"

# Run the image with the repo mounted read-only at /work; $1 is an optional writable host dir at /out.
kit() {
  local out_dir=$1; shift
  local mounts=(-v "$ROOT:/work:ro")
  [ -n "$out_dir" ] && mounts+=(-v "$out_dir:/out")
  docker run --rm --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp "${mounts[@]}" -w /work "$IMAGE" "$@"
}

# DEMO_START DEMO_URL DEMO_READY DEMO_TIMEOUT BASE_DEPS (+ the demo's exported env).
# Assigned first: a failure inside `eval "$(…)"` would be swallowed.
HOST_ENV=$(kit "" env --config "$CONFIG") || die "cannot read $CONFIG"
eval "$HOST_ENV"

DEMO_PID="" DEMO_LOG=$(mktemp)
start_demo() {
  local dir=$1
  : >"$DEMO_LOG"
  ( cd "$dir" && exec setsid bash -c "$DEMO_START" ) >"$DEMO_LOG" 2>&1 &
  DEMO_PID=$!
  local deadline=$((SECONDS + DEMO_TIMEOUT))
  until grep -Eq "$DEMO_READY" "$DEMO_LOG"; do
    kill -0 "$DEMO_PID" 2>/dev/null || { tail -40 "$DEMO_LOG" >&2; die "the demo exited before it was ready"; }
    [ "$SECONDS" -lt "$deadline" ] || { tail -40 "$DEMO_LOG" >&2; die "the demo was not ready after ${DEMO_TIMEOUT}s"; }
    sleep 1
  done
}
stop_demo() {
  [ -n "$DEMO_PID" ] || return 0
  kill -TERM -- "-$DEMO_PID" 2>/dev/null || true
  # The demo tears down its own containers on SIGTERM; give that time before moving on.
  local i=0
  while kill -0 "$DEMO_PID" 2>/dev/null && [ "$i" -lt 90 ]; do sleep 1; i=$((i + 1)); done
  kill -KILL -- "-$DEMO_PID" 2>/dev/null || true
  DEMO_PID=""
}
WORKTREE=""
cleanup() {
  stop_demo
  [ -z "$WORKTREE" ] || git worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -f "$DEMO_LOG"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# capture <profile> <dir>: run the image against the demo that is up, writing into <dir>.
capture() {
  local profile=$1 dir=$2
  mkdir -p "$(dirname "$dir")"
  kit "$(dirname "$dir")" capture "$profile" --config "$CONFIG" --url "$DEMO_URL" --out "/out/$(basename "$dir")" ${ROUTES:+--routes "$ROUTES"}
}

case "$MODE" in
  landing)
    [ -n "$OUT" ] || die "landing needs --out DIR"
    start_demo "$ROOT"; capture landing "$(realpath -m "$OUT")" ;;
  readme)
    start_demo "$ROOT"; capture readme "$(realpath -m "${OUT:-docs/screenshots}")" ;;
  audit)
    [ -n "$SLUG" ] || die "audit needs --slug YYYY-MM-<scope>-<topic>"
    start_demo "$ROOT"; capture audit "$ROOT/docs/audit/assets/$SLUG" ;;
  check)
    OUT=$(realpath -m "${OUT:-visual/.out/check}")
    MERGE_BASE=$(git merge-base HEAD "$BASE_REF") || die "no merge base with $BASE_REF (git fetch origin?)"
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
    KEY=$(printf '%s\n' "$MERGE_BASE" "$IMAGE_ID" "$ROUTES" "$(git hash-object "$CONFIG")" "${DEMO_NOW:-}" | sha256sum | cut -c1-16)
    CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/visual-kit/$(basename "$ROOT")/$KEY"
    if [ "$FRESH" = 1 ] || [ ! -d "$CACHE/shots" ]; then
      echo "visual-kit: capturing the base ($(git rev-parse --short "$MERGE_BASE"), merge-base with $BASE_REF)"
      WORKTREE="$CACHE.wt"
      mkdir -p "$(dirname "$WORKTREE")"
      git worktree add --detach --force "$WORKTREE" "$MERGE_BASE" >/dev/null
      for dep in $BASE_DEPS; do
        [ -e "$ROOT/$dep" ] || continue
        mkdir -p "$WORKTREE/$(dirname "$dep")"
        [ -e "$WORKTREE/$dep" ] || ln -s "$ROOT/$dep" "$WORKTREE/$dep"
      done
      start_demo "$WORKTREE"
      rm -rf "$CACHE/shots"; capture check "$CACHE/shots"
      stop_demo
      git worktree remove --force "$WORKTREE"; WORKTREE=""
    else
      echo "visual-kit: reusing the cached base ($(git rev-parse --short "$MERGE_BASE"))"
    fi
    echo "visual-kit: capturing the working tree"
    start_demo "$ROOT"
    rm -rf "$OUT/head"; capture check "$OUT/head"
    stop_demo
    rm -rf "$OUT/base"; cp -R "$CACHE/shots" "$OUT/base"
    kit "$OUT" compare --base /out/base --head /out/head --out /out/report
    echo "visual-kit: report at ${OUT#"$ROOT"/}/report/index.html (summary: ${OUT#"$ROOT"/}/report/summary.md)"
    ;;
esac

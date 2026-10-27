#!/usr/bin/env bash
# Host side of visual-kit. The demo needs the host's toolchain, so it cannot run in the image:
# this script boots it, runs the image against it and tears it down again.
#
#   run.sh <landing|readme|audit|check> [--routes a,b] [--out DIR] [--base REF] [--slug S] [--fresh] [--force]
#
# An output folder is replaced wholesale, so it must be one this tool wrote (it leaves a .visual-kit file),
# an empty one, or --force. It can never be the repository, one of its parents, or inside .git.
#
# Needs bash, git and docker; flock is optional but recommended. Runs on Linux and macOS (no GNU coreutils needed).
# Environment: VISUAL_KIT_IMAGE (required, set by the Makefile), VISUAL_CONFIG (default visual/scenes.json),
# VISUAL_KIT_HOST_NETWORK=host|bridge (default: host on Linux, bridge elsewhere; see CONTRACT.md).
set -euo pipefail

die() { echo "visual-kit: $*" >&2; exit 1; }

# realpath -m (the path need not exist) without GNU coreutils: absolute, with . and .. folded away, and the part
# that exists resolved through symlinks (so a link to the repository is still the repository). It folds `..`
# lexically before resolving, so `link/..` is the link's own parent here and the link target's parent for GNU
# realpath; both are checked against the repository, which is all the guards need.
realpath_m() {
  if realpath -m / >/dev/null 2>&1; then realpath -m "$1"; return; fi
  local path=$1 part out=() head tail=""
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  local IFS=/
  set -f
  for part in $path; do
    case "$part" in
      "" | .) ;;
      ..) [ ${#out[@]} -eq 0 ] || unset 'out[${#out[@]}-1]' ;;
      *) out+=("$part") ;;
    esac
  done
  set +f
  head="/${out[*]-}"
  unset IFS
  while [ ! -d "$head" ] && [ "$head" != / ]; do tail="/${head##*/}$tail"; head=${head%/*}; [ -n "$head" ] || head=/; done
  head=$(cd -P "$head" && pwd -P)
  echo "${head%/}$tail" | sed 's#^$#/#'
}

# sha256 of stdin, as the bare hex digest.
sha256() {
  if command -v sha256sum >/dev/null 2>&1 && echo | sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1
  fi
}

MODE=${1:-}; shift || true
case "$MODE" in landing | readme | audit | check) ;; *) die "usage: run.sh <landing|readme|audit|check> [options]" ;; esac

ROUTES="" OUT="" BASE_REF="origin/main" SLUG="" FRESH=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --routes) ROUTES=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --base) BASE_REF=$2; shift 2 ;;
    --slug) SLUG=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --force) FORCE=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

IMAGE=${VISUAL_KIT_IMAGE:?VISUAL_KIT_IMAGE is not set}
if [ -n "${VISUAL_KIT_HOST_NETWORK:-}" ]; then NETWORK=$VISUAL_KIT_HOST_NETWORK
elif [ "$(uname -s)" = Linux ]; then NETWORK=host
else NETWORK=bridge
fi
[ "$NETWORK" != bridge ] || [ "$(uname -s)" != Linux ] || echo "visual-kit: bridge networking on Linux reaches the demo through docker0, so it must listen beyond 127.0.0.1; host networking is the default there" >&2
case "$NETWORK" in host | bridge) ;; *) die "VISUAL_KIT_HOST_NETWORK must be host or bridge, got \"$NETWORK\"" ;; esac
ROOT=$(git rev-parse --show-toplevel)
CONFIG=${VISUAL_CONFIG:-visual/scenes.json}
cd "$ROOT"

# A folder this tool writes into and later replaces: empty, or carrying its marker, or --force.
claim_dir() {
  local dir=$1
  if [ -d "$dir" ] && [ ! -e "$dir/.visual-kit" ] && [ -n "$(ls -A "$dir")" ] && [ "$FORCE" != 1 ]; then
    die "$dir exists, is not empty and was not written by visual-kit; refusing to use it (pass --force to allow it once)"
  fi
  mkdir -p "$dir"
  printf 'visual-kit output: this folder is replaced wholesale on every run\n' >"$dir/.visual-kit"
}

# Refuse an output path that would take the checkout (or its parents) with it.
check_out() {
  local out; out=$(realpath_m "$1")
  [ "$out" != / ] || die "refusing --out /"
  case "$ROOT/" in "$out"/*) die "refusing --out $1: it is the repository or one of its parents" ;; esac
  case "$out/" in "$ROOT/.git/"*) die "refusing --out $1: it is inside .git" ;; esac
}

# Run the image with the repo mounted read-only at /work; $1 is an optional writable host dir at /out.
kit() {
  local out_dir=$1; shift
  local mounts=(-v "$ROOT:/work:ro") net=(--network host)
  # Docker Desktop (macOS, Windows) has no usable host networking: reach the demo through host.docker.internal.
  if [ "$NETWORK" = bridge ]; then net=(--add-host host.docker.internal:host-gateway -e VISUAL_KIT_HOST_ALIAS=host.docker.internal); fi
  [ -n "$out_dir" ] && mounts+=(-v "$out_dir:/out")
  docker run --rm --ipc=host "${net[@]}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e "VISUAL_KIT_FORCE=$FORCE" "${mounts[@]}" -w /work "$IMAGE" "$@"
}

# DEMO_START DEMO_URL DEMO_READY DEMO_TIMEOUT BASE_DEPS (+ the demo's exported env).
# Assigned first: a failure inside `eval "$(…)"` would be swallowed.
HOST_ENV=$(kit "" env --config "$CONFIG") || die "cannot read $CONFIG"
eval "$HOST_ENV"

DEMO_PID="" DEMO_LOG=$(mktemp)
start_demo() {
  local dir=$1
  : >"$DEMO_LOG"
  # Own process group, so stop_demo can take the demo's children down with it (macOS has no setsid).
  command -v setsid >/dev/null 2>&1 || command -v perl >/dev/null 2>&1 || die "neither setsid nor perl found; one of them is needed to start the demo in its own process group"
  if command -v setsid >/dev/null 2>&1; then ( cd "$dir" && exec setsid bash -c "$DEMO_START" ) >"$DEMO_LOG" 2>&1 &
  else ( cd "$dir" && exec perl -e 'setpgrp(0, 0); exec @ARGV' bash -c "$DEMO_START" ) >"$DEMO_LOG" 2>&1 &
  fi
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
  # Wait for the whole group, not only its leader: children (compose, a server) tear their own state down.
  local i=0
  while kill -0 -- "-$DEMO_PID" 2>/dev/null && [ "$i" -lt 90 ]; do sleep 1; i=$((i + 1)); done
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
    check_out "$OUT"
    start_demo "$ROOT"; capture landing "$(realpath_m "$OUT")" ;;
  readme)
    check_out "${OUT:-docs/screenshots}"
    start_demo "$ROOT"; capture readme "$(realpath_m "${OUT:-docs/screenshots}")" ;;
  audit)
    [ -n "$SLUG" ] || die "audit needs --slug YYYY-MM-<scope>-<topic>"
    [[ "$SLUG" =~ ^[0-9]{4}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "slug must look like YYYY-MM-<scope>-<topic>, got \"$SLUG\""
    start_demo "$ROOT"; capture audit "$ROOT/docs/audit/assets/$SLUG" ;;
  check)
    check_out "${OUT:-visual/.out/check}"
    OUT=$(realpath_m "${OUT:-visual/.out/check}")
    claim_dir "$OUT"
    MERGE_BASE=$(git merge-base HEAD "$BASE_REF") || die "no merge base with $BASE_REF (git fetch origin?)"
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
    HOOKS="$(dirname "$CONFIG")/hooks.mjs"
    KEY=$(printf '%s\n' "$MERGE_BASE" "$IMAGE_ID" "$ROUTES" "$(git hash-object "$CONFIG")" "$([ -f "$HOOKS" ] && git hash-object "$HOOKS")" "${DEMO_NOW:-}" | sha256 | cut -c1-16)
    CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/visual-kit/$(basename "$ROOT")-$(printf '%s' "$ROOT" | sha256 | cut -c1-8)"
    CACHE="$CACHE_ROOT/$KEY"
    mkdir -p "$CACHE_ROOT"
    # One check at a time per checkout: they share the cache, the worktree, the output and the demo port.
    if command -v flock >/dev/null; then
      exec 9>"$CACHE_ROOT/lock"
      flock -n 9 || die "another visual check is running in this checkout"
    else
      echo "visual-kit: flock not found; two checks at once in this checkout would collide (cache, worktree, demo port)" >&2
    fi
    if [ "$FRESH" = 1 ] || [ ! -d "$CACHE/shots" ]; then
      echo "visual-kit: capturing the base ($(git rev-parse --short "$MERGE_BASE"), merge-base with $BASE_REF)"
      WORKTREE="$CACHE.wt"
      mkdir -p "$(dirname "$WORKTREE")"
      # A SIGKILLed earlier run leaves its worktree behind: drop that one (and only that one) first.
      git worktree remove --force "$WORKTREE" 2>/dev/null || true
      rm -rf "$WORKTREE"
      git worktree add --detach --force "$WORKTREE" "$MERGE_BASE" >/dev/null
      for dep in $BASE_DEPS; do
        [ -e "$ROOT/$dep" ] || continue
        mkdir -p "$WORKTREE/$(dirname "$dep")"
        [ -e "$WORKTREE/$dep" ] || ln -s "$ROOT/$dep" "$WORKTREE/$dep"
      done
      start_demo "$WORKTREE"
      # Scenes are read from the working tree's config, so one that needs a selector the base does not have
      # yet fails here. That is expected for new UI: it shows up as "new" in the report.
      rm -rf "$CACHE/shots"
      capture check "$CACHE/shots" || echo "visual-kit: some scenes failed on the base; they will show as new" >&2
      stop_demo
      # Only a base that rendered something is worth keeping: an empty one (broken demo, no scene matched)
      # would be reused forever and make every shot look new.
      if ! compgen -G "$CACHE/shots/*.png" >/dev/null; then
        rm -rf "$CACHE/shots"
        echo "visual-kit: the base rendered no shots; it is not cached and everything will show as new" >&2
      fi
      git worktree remove --force "$WORKTREE"; WORKTREE=""
    else
      echo "visual-kit: reusing the cached base ($(git rev-parse --short "$MERGE_BASE"))"
    fi
    echo "visual-kit: capturing the working tree"
    start_demo "$ROOT"
    rm -rf "$OUT/head"
    HEAD_RC=0; capture check "$OUT/head" || HEAD_RC=$?
    stop_demo
    rm -rf "$OUT/base"
    if [ -d "$CACHE/shots" ]; then cp -R "$CACHE/shots" "$OUT/base"; else mkdir -p "$OUT/base"; fi
    kit "$OUT" compare --base /out/base --head /out/head --out /out/report
    echo "visual-kit: report at ${OUT#"$ROOT"/}/report/index.html (summary: ${OUT#"$ROOT"/}/report/summary.md)"
    # The report exists even when a scene failed on the working tree, but the failure is not forgotten.
    [ "$HEAD_RC" = 0 ] || die "some scenes failed to render on the working tree (see above)"
    ;;
esac

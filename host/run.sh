#!/usr/bin/env bash
# Host side of visual-kit. The demo needs the host's toolchain, so it cannot run in the image:
# this script boots it, runs the image against it and tears it down again.
#
#   run.sh <landing|readme|audit|check|baseline> [--routes a,b] [--out DIR] [--base REF] [--slug S] [--fresh] [--force]
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
case "$MODE" in landing | readme | audit | check | baseline) ;; *) die "usage: run.sh <landing|readme|audit|check|baseline> [options]" ;; esac

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
  docker run --rm --ipc=host "${net[@]}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e "VISUAL_KIT_FORCE=$FORCE" "${mounts[@]}" ${KIT_EXTRA[@]+"${KIT_EXTRA[@]}"} -w /work "$IMAGE" "$@"
}

# DEMO_START DEMO_URL DEMO_READY DEMO_TIMEOUT BASE_DEPS CACHE_KEY_FILES (+ the demo's exported env).
# Assigned first: a failure inside `eval "$(…)"` would be swallowed.
HOST_ENV=$(kit "" env --config "$CONFIG") || die "cannot read $CONFIG"
eval "$HOST_ENV"

# Host hooks: with a visual/host-hooks.sh, hooks.mjs may call host(name, ...args) during a capture. The image
# writes req-<n> files (name, then one argument per line) into a directory mounted at /hostcall; this watcher
# runs `bash host-hooks.sh <name> <demo-dir> <args…>` from the checkout's copy of the script and answers with
# res-<n> (the exit code, then stdout cut at 64 KiB). Requests are served one at a time. The hook's stdout goes
# through a FIFO (pipe-<n>) into a sink that stores the first 64 KiB in out-<n> and drains the rest, so a chatty
# hook neither fills the temp dir nor is interrupted. The runner removes req-<n> when it gives up
# (hostTimeoutSec): the watcher notices while the hook runs and stops its process group. See CONTRACT.md.
HOST_HOOKS=$(realpath_m "$(dirname "$CONFIG")/host-hooks.sh")
WATCH_PID="" HOSTCALL="" DEMO_DIR="" KIT_EXTRA=() CAPTURE_ARGS=()
# Replaces a subshell with the command in its own process group (setsid, or perl where macOS has none).
in_group() {
  if command -v setsid >/dev/null 2>&1; then exec setsid "$@"; fi
  exec perl -e 'setpgrp(0, 0); exec @ARGV' "$@"
}
# Takes a process group down: TERM, a grace period, then KILL.
stop_group() {
  local pid=$1 i
  kill -TERM -- "-$pid" 2>/dev/null || true
  for i in $(seq 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
hostcall_watch() {
  local dir=$1 demo=$2 req n line name args code pid="" sink="" abandoned i
  # A hook still running when the launcher stops is taken down with its whole process group.
  trap '[ -z "$pid" ] || stop_group "$pid"; [ -z "$sink" ] || stop_group "$sink"; exit 0' TERM
  while :; do
    for req in "$dir"/req-*; do
      case "$req" in *.tmp) continue ;; esac
      [ -f "$req" ] || continue
      n=${req##*/req-}
      args=()
      # A request withdrawn between the test above and this read must not end the watcher.
      { while IFS= read -r line || [ -n "$line" ]; do args+=("$line"); done <"$req"; } 2>/dev/null || continue
      name=${args[0]-}
      [ ${#args[@]} -eq 0 ] || unset 'args[0]'
      rm -f "$dir/pipe-$n"
      if ! mkfifo "$dir/pipe-$n" 2>/dev/null; then
        { printf '1\n'; echo "visual-kit: cannot create a pipe in $dir"; } >"$dir/res-$n.tmp"
        mv "$dir/res-$n.tmp" "$dir/res-$n"
        rm -f "$req"
        continue
      fi
      # The sink copies byte by byte (dd bs=1: unbuffered, so what a hook printed is on disk the moment it is
      # read, even if the sink is stopped later) until 64 KiB, then drains the rest.
      ( in_group bash -c 'dd bs=1 count=65536 of="$1" 2>/dev/null; cat >/dev/null' sink "$dir/out-$n" ) <"$dir/pipe-$n" &
      sink=$!
      ( cd "$demo" && in_group bash "$HOST_HOOKS" "$name" "$demo" ${args[@]+"${args[@]}"} ) >"$dir/pipe-$n" &
      pid=$!
      code=0 abandoned=0
      while kill -0 "$pid" 2>/dev/null; do
        [ -f "$req" ] || { abandoned=1; break; }
        sleep 0.1
      done
      if [ "$abandoned" = 1 ]; then
        stop_group "$pid"
        echo "visual-kit: host hook '$name' stopped: the capture gave up on it" >&2
      else
        wait "$pid" || code=$?
      fi
      pid=""
      # The sink ends when every writer has closed the FIFO; a process the hook left behind may hold it open, so
      # give it a second to finish and then stop it (its output is already on disk).
      for i in $(seq 20); do kill -0 "$sink" 2>/dev/null || break; sleep 0.05; done
      stop_group "$sink"
      sink=""
      if [ "$abandoned" = 0 ]; then
        { printf '%s\n' "$code"; cat "$dir/out-$n" 2>/dev/null || true; } >"$dir/res-$n.tmp"
        mv "$dir/res-$n.tmp" "$dir/res-$n"
      fi
      rm -f "$req" "$dir/out-$n" "$dir/pipe-$n"
    done
    sleep 0.1
  done
}
stop_hostcall() {
  [ -z "$WATCH_PID" ] || { kill "$WATCH_PID" 2>/dev/null || true; wait "$WATCH_PID" 2>/dev/null || true; }
  [ -z "$HOSTCALL" ] || rm -rf "$HOSTCALL"
  WATCH_PID="" HOSTCALL=""
}

DEMO_PID="" DEMO_LOG=$(mktemp)
start_demo() {
  local dir=$1
  DEMO_DIR=$dir
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
  stop_hostcall
  stop_demo
  [ -z "$WORKTREE" ] || git worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -f "$DEMO_LOG"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# capture <profile> <dir>: run the image against the demo that is up, writing into <dir>.
capture() {
  local profile=$1 dir=$2 rc=0
  mkdir -p "$(dirname "$dir")"
  KIT_EXTRA=()
  if [ -f "$HOST_HOOKS" ]; then
    HOSTCALL=$(mktemp -d)
    KIT_EXTRA=(-v "$HOSTCALL:/hostcall" -e VISUAL_KIT_HOSTCALL=/hostcall)
    hostcall_watch "$HOSTCALL" "$DEMO_DIR" &
    WATCH_PID=$!
  fi
  kit "$(dirname "$dir")" capture "$profile" --config "$CONFIG" --url "$DEMO_URL" --out "/out/$(basename "$dir")" ${ROUTES:+--routes "$ROUTES"} ${CAPTURE_ARGS[@]+"${CAPTURE_ARGS[@]}"} || rc=$?
  stop_hostcall
  KIT_EXTRA=()
  return "$rc"
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
  baseline)
    # The committed baselines of the scenes flagged "baseline": true, replaced as a whole, so never narrowed.
    [ -z "$ROUTES" ] || die "baseline regenerates every flagged scene; --routes would drop the others"
    BASELINES="$(dirname "$CONFIG")/baselines"
    check_out "$BASELINES"
    claim_dir "$(realpath_m "$BASELINES")"
    CAPTURE_ARGS=(--baseline-only)
    start_demo "$ROOT"; capture check "$(realpath_m "$BASELINES")" ;;
  check)
    check_out "${OUT:-visual/.out/check}"
    OUT=$(realpath_m "${OUT:-visual/.out/check}")
    claim_dir "$OUT"
    MERGE_BASE=$(git merge-base HEAD "$BASE_REF") || die "no merge base with $BASE_REF (git fetch origin?)"
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
    HOOKS="$(dirname "$CONFIG")/hooks.mjs"
    # What the base was built from but the key would not otherwise see: the listed files, as the working tree has them.
    KEY_FILES=""
    set -f # the schema allows no glob characters; never expand one anyway
    for f in $CACHE_KEY_FILES; do
      if [ -f "$f" ]; then h=$(git hash-object -- "$f") || die "cannot hash $f (cacheKeyFiles)"; else h=absent; fi
      KEY_FILES="$KEY_FILES$f=$h "
    done
    set +f
    KEY=$(printf '%s\n' "$MERGE_BASE" "$IMAGE_ID" "$ROUTES" "$(git hash-object "$CONFIG")" "$([ -f "$HOOKS" ] && git hash-object "$HOOKS")" "$([ -f "$HOST_HOOKS" ] && git hash-object "$HOST_HOOKS")" "${DEMO_NOW:-}" "$KEY_FILES" | sha256 | cut -c1-16)
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
    # Committed baselines (visual/baselines) stand in for the merge base on the scenes that have one; the config
    # lets the report tell whether they were rendered with today's viewport table.
    BASELINES="$(dirname "$CONFIG")/baselines" BASELINE_ARGS=()
    if [ -d "$BASELINES" ]; then BASELINE_ARGS=(--baselines "/work/$BASELINES" --config "$CONFIG"); fi
    kit "$OUT" compare --base /out/base --head /out/head --out /out/report ${BASELINE_ARGS[@]+"${BASELINE_ARGS[@]}"}
    echo "visual-kit: report at ${OUT#"$ROOT"/}/report/index.html (summary: ${OUT#"$ROOT"/}/report/summary.md)"
    # The report exists even when a scene failed on the working tree, but the failure is not forgotten.
    [ "$HEAD_RC" = 0 ] || die "some scenes failed to render on the working tree (see above)"
    ;;
esac

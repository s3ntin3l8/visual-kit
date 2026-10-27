#!/bin/bash
# A stand-in for `docker` in the launcher tests. Logs every call (STUB_LOG), answers `env` with a demo that is only
# an echo and a sleep, and, for a capture with the host-hook channel mounted, plays the container: it files the
# request in $STUB_HOSTCALL (printf %b format) and copies the launcher's answer to $STUB_LOG.res.
echo "$*" >>"$STUB_LOG"
case " $* " in
  *" env --config "*)
    printf "DEMO_START='echo DEMO_READY; exec sleep 60'\nDEMO_URL='http://127.0.0.1:1'\nDEMO_READY='DEMO_READY'\nDEMO_TIMEOUT='5'\nBASE_DEPS=''\nCACHE_KEY_FILES='%s'\n" "$STUB_KEY_FILES" ;;
  "image inspect"*) echo sha256:stubimage ;;
  *" capture "*)
    if [ -n "${STUB_HOSTCALL-}" ]; then
      dir=$(printf '%s\n' "$@" | sed -n 's#^\(.*\):/hostcall$#\1#p')
      if [ -n "$dir" ]; then
        printf '%b' "$STUB_HOSTCALL" >"$dir/req-t.tmp" && mv "$dir/req-t.tmp" "$dir/req-t"
        for _ in $(seq 100); do [ -f "$dir/res-t" ] && break; sleep 0.1; done
        cp "$dir/res-t" "$STUB_LOG.res" 2>/dev/null
      fi
    fi ;;
esac

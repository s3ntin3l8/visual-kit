#!/bin/bash
# A stand-in for `docker` in the launcher tests. Logs every call (STUB_LOG), answers `env` with a demo that is only
# an echo and a sleep, and, for a capture with the host-hook channel mounted, plays the container: it files the
# request in $STUB_HOSTCALL (printf %b format) and copies the launcher's answer to $STUB_LOG.res. Without an answer
# it withdraws the request like the runner does (STUB_KEEP_REQUEST=1 keeps it), then lingers STUB_LINGER seconds.
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
        for _ in $(seq "${STUB_HOSTCALL_WAIT:-100}"); do [ -f "$dir/res-t" ] && break; sleep 0.1; done
        if [ -f "$dir/res-t" ]; then cp "$dir/res-t" "$STUB_LOG.res"
        elif [ -z "${STUB_KEEP_REQUEST-}" ]; then rm -f "$dir/req-t"; fi # the runner withdraws a request it gave up on
        # The capture outlives the request for STUB_LINGER seconds, then says whether the hook (pid in STUB_PIDFILE) is still alive.
        # A second request, filed once the first was answered: proves the watcher went on serving.
        if [ -n "${STUB_HOSTCALL2-}" ] && [ -f "$dir/res-t" ]; then
          printf '%b' "$STUB_HOSTCALL2" >"$dir/req-u.tmp" && mv "$dir/req-u.tmp" "$dir/req-u"
          for _ in $(seq 100); do [ -f "$dir/res-u" ] && break; sleep 0.1; done
          cp "$dir/res-u" "$STUB_LOG.res2" 2>/dev/null
        fi
        sleep "${STUB_LINGER:-0}"
        if [ -n "${STUB_PIDFILE-}" ]; then
          if kill -0 "$(cat "$STUB_PIDFILE" 2>/dev/null)" 2>/dev/null; then echo alive; else echo gone; fi >"$STUB_LOG.alive"
        fi
      fi
    fi ;;
esac

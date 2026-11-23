# stdin carries host responses; stdout remains the original lifecycle stream.
umask 077
exec 3<> "$1" || exit 1
cat <&3 &
reader=$!
trap 'rm -f -- "$1" 2>/dev/null || :; kill "$reader" 2>/dev/null || :; wait "$reader" 2>/dev/null || :' EXIT
trap 'exit 0' HUP INT TERM
while IFS=' ' read -r kind ticket decision extra; do
  [ "$kind" = TTY-RECOVERY ] && [ -z "$extra" ] || continue
  case "$ticket" in ''|0*|*[!0-9]*) continue ;; esac
  [ "${#ticket}" -le 10 ] || continue
  case "$decision" in 0|1|2) ;; *) continue ;; esac
  (set -C; : > "$1.tty-reply-$ticket-$decision") 2>/dev/null || :
done

#!/bin/sh
# The host and editor use separate SSH/job streams. Only the two private FIFOs
# carry editor requests and replies. A second editor cannot consume this stream.
set -eu
umask 077
cd "$1"
role=$2

cleanup() {
    if [ -n "${reader-}" ]; then
        kill "$reader" 2>/dev/null || :
        wait "$reader" 2>/dev/null || :
    fi
    if [ "$role" = host ]; then
        rm -f request response uid bridge.vim relay.sh
        rmdir editor.lock 2>/dev/null || :
        rmdir "$1" 2>/dev/null || :
    else
        rmdir editor.lock 2>/dev/null || :
    fi
}

case "$role" in
    host)
        trap 'cleanup "$1"' EXIT
        [ -r /proc/self/stat ]
        mkfifo request response
        id -u > uid
        exec 3<> request 4<> response
        printf '%s\n' "$3"
        ;;
    editor)
        [ -p request ] && [ -p response ]
        mkdir editor.lock
        trap 'cleanup "$1"' EXIT
        exec 3<> response 4<> request
        ;;
    *) exit 1 ;;
esac
trap 'exit 0' HUP INT TERM
# Forward small reads immediately, including single editor acknowledgements.
# The second sink is discarded so the stream stays unbuffered and off disk.
tee /dev/null <&4 &
reader=$!
tee /dev/null >&3

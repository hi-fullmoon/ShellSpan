#!/bin/sh
set -eu

ssh-keygen -A
dockerd --host=unix:///var/run/docker.sock > /var/log/shellspan-fixture-dockerd.log 2>&1 &
dockerd_pid=$!

attempt=0
while ! docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  sleep 1
done

trap 'kill "$dockerd_pid" 2>/dev/null || true' INT TERM EXIT
exec /usr/sbin/sshd -D -e

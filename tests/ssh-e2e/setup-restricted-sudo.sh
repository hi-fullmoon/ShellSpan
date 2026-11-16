#!/bin/sh
set -eu

fixture_dir=$1
install -d -m 0755 /usr/local/libexec /usr/local/libexec/shellspan-sudo-jobs /etc/shellspan-sudo /run/sshd
install -m 0755 "$fixture_dir/shellspan-sudo-runner" /usr/local/libexec/shellspan-sudo-runner
install -m 0755 "$fixture_dir/restricted-sudo-effective-user" /usr/local/libexec/shellspan-sudo-jobs/effective-user
install -m 0644 "$fixture_dir/restricted-sudo-jobs.json" /etc/shellspan-sudo/jobs.json
install -m 0440 "$fixture_dir/restricted-sudoers" /etc/sudoers.d/shellspan-restricted
install -m 0644 "$fixture_dir/sshd_config.example" /etc/ssh/shellspan_runner_config
adduser -D -H -h / -s /usr/local/libexec/shellspan-sudo-runner shellspan-runner
printf '%s:%s\n' shellspan-runner "$SHELLSPAN_E2E_SUDO_RUNNER_PASSWORD" | chpasswd
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/shellspan_runner_ed25519_key
visudo -c
/usr/sbin/sshd -t -f /etc/ssh/shellspan_runner_config
/usr/sbin/sshd -f /etc/ssh/shellspan_runner_config

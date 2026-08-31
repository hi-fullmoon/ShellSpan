import { describe, expect, it } from 'vitest';
import { isSafeReadOnlyCommand } from '../safe-shell-command';

describe('safe read-only command validation', () => {
  it.each([
    'sudo df -h',
    'df -h && rm -rf /tmp/cache',
    'systemctl restart nginx',
    'journalctl --vacuum-size=1M',
    'date -s 12:00:00',
    'hostname compromised-host',
    'ss -K dst 203.0.113.10',
    'cat /etc/hosts > /tmp/hosts',
    'tail -f /var/log/system.log',
    'docker logs app',
    'docker stats',
    'kubectl get pods --watch',
    'cat /dev/zero',
    'cat /dev/tty',
    'cat /dev/./zero',
    './df -h',
    '/tmp/df -h',
    'C:/Users/operator/bin/whoami.exe',
    'free -s 1',
    'free -s 1 -c 0',
    'lsof -r 1',
    'lsof +r2',
    'netstat -c',
    'netstat --continuous',
    'netstat -w 1',
    'netstat -anw 1',
    'ss -E',
    'ss -Etn',
    'ss -Ktn dst 203.0.113.10',
    'ss --events',
    'ss -D /tmp/ss.dump',
    'ss --diag=/tmp/ss.dump',
  ])('rejects unsafe commands: %s', (command) => {
    expect(isSafeReadOnlyCommand(command)).toBe(false);
  });

  it.each([
    'df -h',
    'date -u +%FT%T',
    'hostname -f',
    'ss -lntp',
    'journalctl -u nginx -n 50',
    'systemctl status nginx',
    'docker logs --tail 200 app',
    'docker stats --no-stream',
    'kubectl logs app --tail=200',
    'free -s 1 -c 2',
    'lsof -iTCP',
    'netstat -an',
  ])('allows bounded read-only commands: %s', (command) => {
    expect(isSafeReadOnlyCommand(command)).toBe(true);
  });
});

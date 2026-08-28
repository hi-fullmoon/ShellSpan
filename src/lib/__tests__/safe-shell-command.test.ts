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
  ])('allows bounded read-only commands: %s', (command) => {
    expect(isSafeReadOnlyCommand(command)).toBe(true);
  });
});

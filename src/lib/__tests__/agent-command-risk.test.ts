import { describe, expect, it } from 'vitest';
import { classifyAgentCommandRisk } from '../agent-command-risk';

describe('Agent command risk classification', () => {
  it.each([
    'systemctl status nginx',
    'journalctl -u nginx -n 100',
    'ss -lntp',
    'df -h',
    'ps aux | grep nginx',
    'systemctl status nginx && journalctl -u nginx -n 20',
  ])('reuses the bounded read-only allowlist: %s', (command) => {
    expect(classifyAgentCommandRisk(command).risk).toBe('readOnly');
  });

  it.each([
    'systemctl restart nginx',
    'apt install nginx',
    'chmod 600 /etc/example.conf',
    'cat /etc/hosts > /tmp/hosts',
    'future-command --unknown',
    'echo $(touch /tmp/changed)',
    'systemctl status nginx && systemctl restart nginx',
    'df -h | tee /tmp/disk.txt',
    "grep 'a|b' /tmp/example.log | head -n 5",
  ])('fails closed to stateChange when it is not wholly read-only: %s', (command) => {
    expect(classifyAgentCommandRisk(command)).toMatchObject({
      risk: 'stateChange',
    });
  });

  it.each([
    'rm -rf /tmp/cache',
    'sudo -n rm -rf /var/cache/app',
    'df -h && rm -rf /tmp/cache',
    'systemctl status nginx || shutdown -h now',
    'echo $(mkfs.ext4 /dev/sdb1)',
    'iptables -F',
    'nft flush ruleset',
    'git reset --hard HEAD~1',
    'docker system prune -af',
    'kubectl delete namespace production',
    'psql -c "DROP DATABASE production"',
  ])('classifies destructive patterns before any harmless fragment: %s', (command) => {
    expect(classifyAgentCommandRisk(command)).toEqual({
      risk: 'destructive',
      reason: 'destructivePattern',
    });
  });

  it('takes the highest risk across compound commands regardless of order', () => {
    expect(classifyAgentCommandRisk(
      'systemctl status nginx; systemctl restart nginx; rm -rf /tmp/cache; df -h',
    ).risk).toBe('destructive');
    expect(classifyAgentCommandRisk(
      'df -h && systemctl restart nginx && systemctl status nginx',
    ).risk).toBe('stateChange');
  });
});

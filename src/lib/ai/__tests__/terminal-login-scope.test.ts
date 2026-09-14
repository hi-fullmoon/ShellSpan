import { describe, expect, it } from 'vitest';

import { terminalLoginLabel, terminalLoginScopeKey } from '../terminal-login-scope';

describe('terminal login history scope', () => {
  it('groups reconnects by SSH user, host, and port instead of terminal ID', () => {
    const login = { host: '175.178.66.45', port: 22, username: 'root' };
    const target = { kind: 'remote' as const, targetId: 'terminal-old', sessionId: 'old', ...login };
    expect(terminalLoginScopeKey(login)).toBe(terminalLoginScopeKey(target));
    expect(terminalLoginLabel(login)).toBe('root@175.178.66.45:22');
    expect(terminalLoginScopeKey({ ...login, username: 'deploy' })).not.toBe(terminalLoginScopeKey(login));
    expect(terminalLoginScopeKey({ ...login, port: 2222 })).not.toBe(terminalLoginScopeKey(login));
  });

  it('normalizes host casing and IPv6 brackets while keeping local terminals separate', () => {
    const ipv6 = { host: '[2001:DB8::1]', port: 22, username: 'root' };
    expect(terminalLoginScopeKey(ipv6)).toBe(terminalLoginScopeKey({ ...ipv6, host: '2001:db8::1' }));
    expect(terminalLoginLabel(ipv6)).toBe('root@[2001:db8::1]:22');
    expect(terminalLoginScopeKey({ host: 'local', port: 0, username: 'alice' }))
      .toBe(terminalLoginScopeKey({ kind: 'local', targetId: 'terminal-old', sessionId: 'old' }));
    expect(terminalLoginLabel({ host: 'local', port: 0, username: 'alice' })).toBe('alice@local');
  });
});

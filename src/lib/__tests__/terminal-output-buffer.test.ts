import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendTerminalOutput,
  clearTerminalOutput,
  getRecentTerminalOutput,
  rebindTerminalOutput,
  renderTerminalText,
  redactTerminalSecrets,
  stripAnsi,
  subscribeTerminalOutput,
} from '../terminal-output-buffer';

describe('terminal output buffer', () => {
  beforeEach(() => {
    clearTerminalOutput('session-1');
    clearTerminalOutput('session-2');
  });

  it('normalizes ANSI escapes and carriage return redraws', () => {
    const rendered = renderTerminalText(stripAnsi('\u001b[31mprogress 10%\rprogress 90%\u001b[0m\n'));
    expect(rendered).toBe('progress 90%');
  });

  it('returns only recent lines and redacts common secrets', () => {
    appendTerminalOutput('session-1', 'first\npassword=hunter2\nthird\n');
    expect(getRecentTerminalOutput('session-1', 2)).toBe('password=[REDACTED]\nthird');
  });

  it('redacts credential formats before AI context or archives are written', () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'sensitive-key-material',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const input = [
      privateKey,
      'Authorization: Bearer bearer-secret',
      'export CLIENT_SECRET="client-secret"',
      'curl --api-key command-secret https://alice:url-secret@example.com',
      'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234',
      'SESSION=eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
    ].join('\n');

    const redacted = redactTerminalSecrets(input);

    for (const secret of [
      'sensitive-key-material',
      'bearer-secret',
      'client-secret',
      'command-secret',
      'url-secret',
      'AKIA1234567890ABCDEF',
      'ghp_abcdefghijklmnopqrstuvwxyz1234',
      'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('[REDACTED PRIVATE KEY]');
  });

  it('moves buffered output when a session reconnects', () => {
    appendTerminalOutput('session-1', 'before reconnect\n');
    rebindTerminalOutput('session-1', 'session-2');
    expect(getRecentTerminalOutput('session-1', 20)).toBe('');
    expect(getRecentTerminalOutput('session-2', 20)).toBe('before reconnect');
  });

  it('keeps only the newest 256 KiB without corrupting UTF-8 boundaries', () => {
    appendTerminalOutput('session-1', `${'x'.repeat(256 * 1024)}你`);

    const output = getRecentTerminalOutput('session-1', 1);
    expect(output.endsWith('你')).toBe(true);
    expect(output).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(256 * 1024);
  });

  it('retains ordering across many small chunks after trimming', () => {
    for (let index = 0; index < 20_000; index += 1) {
      appendTerminalOutput('session-1', `${String(index).padStart(5, '0')}\n`);
    }

    const output = getRecentTerminalOutput('session-1', 3);
    expect(output).toBe('19997\n19998\n19999');
  });

  it('notifies live consumers when a session buffer changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalOutput(listener);

    appendTerminalOutput('session-1', 'new output\n');
    unsubscribe();
    appendTerminalOutput('session-1', 'ignored\n');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('session-1');
  });
});

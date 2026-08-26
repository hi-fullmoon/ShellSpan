import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendTerminalOutput,
  clearTerminalOutput,
  getRecentTerminalOutput,
  getRecentTerminalOutputSnapshot,
  rebindTerminalOutput,
  renderTerminalText,
  redactTerminalSecrets,
  stripAnsi,
  subscribeTerminalOutput,
  truncateAiContext,
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

  it('reuses an already-redacted snapshot until the output version changes', () => {
    appendTerminalOutput('session-1', 'first\npassword=first-secret\n');

    const first = getRecentTerminalOutputSnapshot('session-1', 20);
    const repeated = getRecentTerminalOutputSnapshot('session-1', 20);

    expect(repeated).toBe(first);
    expect(repeated.content).not.toContain('first-secret');

    appendTerminalOutput('session-1', 'next\n');
    const appended = getRecentTerminalOutputSnapshot('session-1', 20);
    expect(appended).not.toBe(first);
    expect(appended.version).toBeGreaterThan(first.version);
    expect(appended.content).toBe('first\npassword=[REDACTED]\nnext');
    expect(getRecentTerminalOutputSnapshot('session-1', 20)).toBe(appended);
  });

  it('invalidates the cached line window when the context setting changes', () => {
    appendTerminalOutput('session-1', 'one\ntwo\nthree\n');

    const twoLines = getRecentTerminalOutputSnapshot('session-1', 2);
    const threeLines = getRecentTerminalOutputSnapshot('session-1', 3);

    expect(twoLines.content).toBe('two\nthree');
    expect(threeLines.content).toBe('one\ntwo\nthree');
    expect(threeLines).not.toBe(twoLines);
    expect(getRecentTerminalOutputSnapshot('session-1', 3)).toBe(threeLines);
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

  it('redacts an incomplete private key block instead of caching its body', () => {
    appendTerminalOutput(
      'session-1',
      '-----BEGIN OPENSSH PRIVATE KEY-----\npartial-sensitive-body\n',
    );

    const snapshot = getRecentTerminalOutputSnapshot('session-1', 20);
    expect(snapshot.content).toBe('[REDACTED PRIVATE KEY]');
    expect(snapshot.content).not.toContain('partial-sensitive-body');

    appendTerminalOutput('session-1', '-----END OPENSSH PRIVATE KEY-----\nafter\n');
    expect(getRecentTerminalOutput('session-1', 20)).toBe(
      '[REDACTED PRIVATE KEY]\nafter',
    );
  });

  it('falls back safely for secrets and ANSI sequences split across chunks', () => {
    appendTerminalOutput('session-1', 'password=');
    getRecentTerminalOutputSnapshot('session-1', 20);
    appendTerminalOutput('session-1', 'cross-chunk-secret\n');
    expect(getRecentTerminalOutput('session-1', 20)).toBe('password=[REDACTED]');

    appendTerminalOutput('session-1', '\u001b[3');
    getRecentTerminalOutputSnapshot('session-1', 20);
    appendTerminalOutput('session-1', '1mred\u001b[0m\n');
    const output = getRecentTerminalOutput('session-1', 20);
    expect(output).toContain('red');
    expect(output).not.toContain('cross-chunk-secret');
    expect(output).not.toContain('[31m');
  });

  it('matches the full safety pipeline across incremental and fallback boundaries', () => {
    const chunks = [
      '\u001b[32mfirst\u001b[0m\n',
      '\n',
      'progress 10%\rprogress 90%\n',
      '你',
      '好\n',
      '\u001b]0;split title',
      '\u0007visible\n',
      'Authorization: Bearer ',
      'boundary-secret\n',
    ];
    let raw = '';

    for (const chunk of chunks) {
      appendTerminalOutput('session-1', chunk);
      raw += chunk;
      const expected = truncateAiContext(
        redactTerminalSecrets(renderTerminalText(stripAnsi(raw)))
          .split('\n')
          .slice(-20)
          .join('\n')
          .trim(),
      );
      expect(getRecentTerminalOutput('session-1', 20)).toBe(expected);
    }
    expect(getRecentTerminalOutput('session-1', 20)).not.toContain('boundary-secret');
    expect(getRecentTerminalOutput('session-1', 20)).not.toContain('\uFFFD');
  });

  it('moves buffered output when a session reconnects', () => {
    appendTerminalOutput('session-1', 'before reconnect\n');
    const oldSnapshot = getRecentTerminalOutputSnapshot('session-1', 20);
    rebindTerminalOutput('session-1', 'session-2');
    expect(getRecentTerminalOutput('session-1', 20)).toBe('');
    expect(getRecentTerminalOutput('session-2', 20)).toBe('before reconnect');
    expect(getRecentTerminalOutputSnapshot('session-2', 20)).not.toBe(oldSnapshot);
  });

  it('invalidates snapshots on clear and session reconstruction', () => {
    appendTerminalOutput('session-1', 'old output\n');
    const oldSnapshot = getRecentTerminalOutputSnapshot('session-1', 20);

    clearTerminalOutput('session-1');
    expect(getRecentTerminalOutput('session-1', 20)).toBe('');
    appendTerminalOutput('session-1', 'new output\n');

    const rebuiltSnapshot = getRecentTerminalOutputSnapshot('session-1', 20);
    expect(rebuiltSnapshot).not.toBe(oldSnapshot);
    expect(rebuiltSnapshot.content).toBe('new output');
  });

  it('keeps only the newest 256 KiB without corrupting UTF-8 boundaries', () => {
    appendTerminalOutput('session-1', `${'x'.repeat(256 * 1024)}你`);

    const output = getRecentTerminalOutput('session-1', 1);
    expect(output.endsWith('你')).toBe(true);
    expect(output).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(256 * 1024);
  });

  it('bounds oversized selected context by UTF-8 bytes and keeps the newest text', () => {
    const context = `old-prefix-${'你'.repeat(100)}-latest`;
    const truncated = truncateAiContext(context, 80);

    expect(truncated).toContain('earlier terminal content omitted');
    expect(truncated).not.toContain('old-prefix');
    expect(truncated).toContain('-latest');
    expect(truncated).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(80);
  });

  it('retains ordering across many small chunks after trimming', () => {
    for (let index = 0; index < 20_000; index += 1) {
      appendTerminalOutput('session-1', `${String(index).padStart(5, '0')}\n`);
    }

    const output = getRecentTerminalOutput('session-1', 3);
    expect(output).toBe('19997\n19998\n19999');
  });

  it('invalidates the incremental cache when the saturated buffer wraps', () => {
    appendTerminalOutput('session-1', `${'old\n'.repeat(70_000)}password=old-secret\n`);
    const saturated = getRecentTerminalOutputSnapshot('session-1', 3);
    expect(saturated.content).not.toContain('old-secret');

    appendTerminalOutput('session-1', 'password=wrap-secret\nlatest-你\n');
    const wrapped = getRecentTerminalOutputSnapshot('session-1', 3);

    expect(wrapped).not.toBe(saturated);
    expect(wrapped.content).toContain('password=[REDACTED]');
    expect(wrapped.content).toContain('latest-你');
    expect(wrapped.content).not.toContain('wrap-secret');
    expect(wrapped.content).not.toContain('\uFFFD');
  });

  it('notifies only consumers subscribed to the changed session', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalOutput('session-1', listener);

    appendTerminalOutput('session-2', 'background output\n');
    appendTerminalOutput('session-1', 'new output\n');
    unsubscribe();
    appendTerminalOutput('session-1', 'ignored\n');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith();
  });
});

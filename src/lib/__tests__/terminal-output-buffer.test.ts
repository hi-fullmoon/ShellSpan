import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendTerminalOutput,
  clearTerminalOutput,
  getRecentTerminalOutput,
  rebindTerminalOutput,
  renderTerminalText,
  stripAnsi,
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
});

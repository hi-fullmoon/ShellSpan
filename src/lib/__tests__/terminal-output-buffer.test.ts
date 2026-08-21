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
});

import { describe, expect, it } from 'vitest';
import {
  canInsertIntoTerminal,
  isTerminalInsertLanguage,
  sanitizeSingleLineTerminalCommand,
  terminalSessionDisplayName,
} from '../terminal-insert';

describe('terminal-insert helpers', () => {
  it('accepts single-line commands and strips trailing newlines without allowing multiline input', () => {
    expect(sanitizeSingleLineTerminalCommand('df -h')).toBe('df -h');
    expect(sanitizeSingleLineTerminalCommand('kubectl get pods -n prod\n')).toBe('kubectl get pods -n prod');
    expect(sanitizeSingleLineTerminalCommand('uptime\r\n')).toBe('uptime');
    expect(sanitizeSingleLineTerminalCommand('echo first\necho second')).toBeNull();
    expect(sanitizeSingleLineTerminalCommand('echo first\recho second')).toBeNull();
    expect(sanitizeSingleLineTerminalCommand('   \n')).toBeNull();
    expect(sanitizeSingleLineTerminalCommand('')).toBeNull();
  });

  it('allows shell and unlabelled code blocks while excluding non-shell languages', () => {
    expect(isTerminalInsertLanguage('')).toBe(true);
    expect(isTerminalInsertLanguage('bash')).toBe(true);
    expect(isTerminalInsertLanguage('SH')).toBe(true);
    expect(isTerminalInsertLanguage('zsh')).toBe(true);
    expect(isTerminalInsertLanguage('powershell')).toBe(true);
    expect(isTerminalInsertLanguage('typescript')).toBe(false);
    expect(isTerminalInsertLanguage('json')).toBe(false);
    expect(isTerminalInsertLanguage('yaml')).toBe(false);
    expect(isTerminalInsertLanguage('python')).toBe(false);
  });

  it('prefers manual title, then title, then host for display name', () => {
    expect(terminalSessionDisplayName({ manualTitle: ' prod-web-01 ', title: 'web', host: '10.0.0.1' })).toBe('prod-web-01');
    expect(terminalSessionDisplayName({ manualTitle: '  ', title: 'app-server', host: '10.0.0.2' })).toBe('app-server');
    expect(terminalSessionDisplayName({ title: '', host: '10.0.0.3' })).toBe('10.0.0.3');
  });

  it('requires a connected, writable, ready, unblocked terminal', () => {
    expect(canInsertIntoTerminal({
      session: { status: 'connected', readOnly: false },
      preparing: false,
      blockedByAgent: false,
      hasTerminal: true,
    })).toBe(true);

    expect(canInsertIntoTerminal({
      session: { status: 'disconnected', readOnly: false },
      preparing: false,
      blockedByAgent: false,
    })).toBe(false);

    expect(canInsertIntoTerminal({
      session: { status: 'connected', readOnly: true },
      preparing: false,
      blockedByAgent: false,
    })).toBe(false);

    expect(canInsertIntoTerminal({
      session: { status: 'connected', readOnly: false },
      preparing: true,
      blockedByAgent: false,
    })).toBe(false);

    expect(canInsertIntoTerminal({
      session: { status: 'connected', readOnly: false },
      preparing: false,
      blockedByAgent: true,
    })).toBe(false);

    expect(canInsertIntoTerminal({
      session: { status: 'connected', readOnly: false },
      preparing: false,
      blockedByAgent: false,
      hasTerminal: false,
    })).toBe(false);
  });
});

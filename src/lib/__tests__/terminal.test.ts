import { describe, expect, it } from 'vitest';
import {
  formatTerminalStatusLine,
  shouldDisableTerminalInput,
  shouldReconnectFromInput,
  shouldWarnOnClosedSession,
} from '../terminal';

describe('formatTerminalStatusLine', () => {
  it('formats connected status with a localized ready message', () => {
    expect(formatTerminalStatusLine('connected', 'shell ready')).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[33m[已连接]\u001b[0m 终端已就绪',
    );
  });

  it('keeps the same bracketed format for custom status messages', () => {
    expect(formatTerminalStatusLine('connecting', 'dialing example.com:22...')).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[33m[连接中]\u001b[0m dialing example.com:22...',
    );
  });

  it('omits the trailing separator when no message is present', () => {
    expect(formatTerminalStatusLine('error')).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[33m[错误]\u001b[0m',
    );
  });
});

describe('shouldDisableTerminalInput', () => {
  it('keeps terminal input enabled after disconnection so enter can trigger reconnect', () => {
    expect(shouldDisableTerminalInput('disconnected')).toBe(false);
    expect(shouldDisableTerminalInput('error')).toBe(false);
  });

  it('disables terminal input only while a session is still connecting', () => {
    expect(shouldDisableTerminalInput('connecting')).toBe(true);
    expect(shouldDisableTerminalInput('connected')).toBe(false);
  });
});

describe('shouldReconnectFromInput', () => {
  it('treats enter as a reconnect trigger for disconnected sessions', () => {
    expect(shouldReconnectFromInput('disconnected', '\r')).toBe(true);
    expect(shouldReconnectFromInput('error', '\n')).toBe(true);
  });

  it('ignores non-enter input and connected sessions', () => {
    expect(shouldReconnectFromInput('disconnected', 'a')).toBe(false);
    expect(shouldReconnectFromInput('connected', '\r')).toBe(false);
    expect(shouldReconnectFromInput('connecting', '\n')).toBe(false);
  });
});

describe('shouldWarnOnClosedSession', () => {
  it('suppresses duplicate close warnings after an error status was already emitted', () => {
    expect(shouldWarnOnClosedSession('error')).toBe(false);
  });

  it('keeps close warnings for non-error shutdown paths', () => {
    expect(shouldWarnOnClosedSession('connected')).toBe(true);
    expect(shouldWarnOnClosedSession('disconnected')).toBe(true);
    expect(shouldWarnOnClosedSession('connecting')).toBe(true);
  });
});

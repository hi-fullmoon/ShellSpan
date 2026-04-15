import { describe, expect, it } from 'vitest';
import { shouldDisableTerminalInput, shouldReconnectFromInput } from '../terminalStatus';

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

import { describe, expect, it } from 'vitest';
import { formatTerminalStatusLine } from '../terminalOutput';

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

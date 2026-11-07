import { describe, expect, it } from 'vitest';
import { exactTerminalPasteText } from '../terminal-clipboard';

describe('native clipboard text bound to a paste event', () => {
  it('preserves decomposed bytes instead of WebView-composed text', () => {
    const original = "printf '%s\\n' '中文 e\u0301 👩🏽‍💻'";
    expect(exactTerminalPasteText(original.normalize('NFC'), original)).toBe(original);
  });
  it('retains the event text when the clipboard has changed', () => {
    expect(exactTerminalPasteText('printf safe', 'rm -rf unrelated')).toBe('printf safe');
    expect(exactTerminalPasteText('printf é', 'printf é\n')).toBe('printf é');
    expect(exactTerminalPasteText('👩🏽‍💻', '👩‍💻')).toBe('👩🏽‍💻');
  });
  it('preserves tabs and line endings and does not equate compatibility characters', () => {
    const original = 'printf\t e\u0301\r\n';
    expect(exactTerminalPasteText(original.normalize('NFC'), original)).toBe(original);
    expect(exactTerminalPasteText('A', 'Ａ')).toBe('A');
  });
});

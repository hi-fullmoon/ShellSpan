import { describe, expect, it } from 'vitest';
import { activeFileToken, formatFileMention, insertFileMention } from '../file-reference-grammar';
describe('file reference grammar', () => {
  it.each(['a@b.com', 'hello a@b', '@"done" ', 'text', '@bad"name', '@x\ny'])('does not activate %s at end', text => expect(activeFileToken(text, text.length)).toBeNull());
  it.each(['@', 'use @src', '🙂\n@"space dir/', 'text @"space path'])('activates only a token at its caret: %s', text => expect(activeFileToken(text, text.length)).not.toBeNull());
  it('keeps surrounding text and replaces complete token when caret is in its middle', () => {
    const text = 'before @unfinished after';
    expect(insertFileMention(text, activeFileToken(text, 10)!, { path: 'chosen.txt', kind: 'file' })).toEqual({ text: 'before @chosen.txt after', caret: 18 });
    expect(activeFileToken(text, 10, 12)).toBeNull();
  });
  it('keeps quoted directory open, then closes a file and replaces old closing quote', () => {
    expect(formatFileMention({ path: 'space dir', kind: 'directory' })).toBe('@"space dir/');
    expect(formatFileMention({ path: 'plain', kind: 'directory' }, true)).toBe('@"plain/');
    const text = 'see @"space dir/old.txt" later'; const caret = text.indexOf('old') + 1;
    expect(insertFileMention(text, activeFileToken(text, caret)!, { path: 'space dir/new.txt', kind: 'file' })?.text).toBe('see @"space dir/new.txt" later');
  });
  it.each(['../escape', '/absolute', 'quote"', 'line\nfeed', 'bad\\path', 'C:/drive', 'x//y', '\u0085', 'a\u2028b'])('rejects unrepresentable path %s', path => expect(formatFileMention({ path, kind: 'file' })).toBeNull());
});

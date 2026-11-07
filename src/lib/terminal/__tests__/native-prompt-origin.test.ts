import {beforeAll, expect, it} from 'vitest';
import {Terminal} from '@xterm/xterm';
import {UnicodeGraphemesAddon} from '@xterm/addon-unicode-graphemes';
import {enableRealCanvas} from '@/tests/real-canvas';
import {observeNativePromptOrigin} from '../native-prompt-origin';

beforeAll(enableRealCanvas);
const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve));

it.each([20, 47, 58, 199])('captures only cell widths across actual soft wraps and wide-cell padding at %i columns', async columns => {
  const term = new Terminal({cols: columns, rows: 30, allowProposedApi: true});
  const host = document.createElement('div');document.body.append(host);term.open(host);term.loadAddon(new UnicodeGraphemesAddon());
  const input: string[] = [];term.onData(value => input.push(value));
  try {
    await write(term, '\x1b[36m' + '界'.repeat(53) + '> \x1b[0m');
    const buffer = term.buffer.active;
    const request = {requestId: 1, columns, rows: 30, cursorX: buffer.cursorX, cursorY: buffer.cursorY};
    const before = term.buffer.normal.getLine(0)?.translateToString();
    const result = observeNativePromptOrigin(term, request);
    expect(result?.cellWidths).toEqual([...Array<number>(53).fill(2), 1, 1]);
    expect(Object.keys(result ?? {})).toEqual(['requestId', 'columns', 'rows', 'cursorX', 'cursorY', 'cellWidths', 'wrapPending']);
    expect(result?.wrapPending).toBe(false);
    const withExtra = {...request, sourceText: 'MUST_NOT_ESCAPE'};
    expect(Object.keys(observeNativePromptOrigin(term, withExtra) ?? {})).toEqual(Object.keys(result ?? {}));
    expect(JSON.stringify(observeNativePromptOrigin(term, withExtra))).not.toContain('MUST_NOT_ESCAPE');
    expect(term.buffer.normal.getLine(0)?.translateToString()).toBe(before);expect(input).toEqual([]);
    expect(observeNativePromptOrigin(term, {...request, cursorX: request.cursorX + 1})).toBeUndefined();
    expect(observeNativePromptOrigin(term, {...request, requestId: Number.NaN})).toBeUndefined();
    expect(observeNativePromptOrigin(term, {...request, columns: columns + 1})).toBeUndefined();
    await write(term, '\x1b[?1049h');
    expect(observeNativePromptOrigin(term, {...request, cursorX: 0, cursorY: 0})).toBeUndefined();
  } finally {term.dispose();host.remove();}
});

it.each(['p'.repeat(40), '界'.repeat(20)])('reports all cells and explicit pending wrap without changing the terminal: %s', async text => {
  const term = new Terminal({cols: 40, rows: 3, allowProposedApi: true});
  const host = document.createElement('div');document.body.append(host);term.open(host);term.loadAddon(new UnicodeGraphemesAddon());
  const input: string[] = [];term.onData(value => input.push(value));
  try {
    await write(term, '\r\n\r\n' + text);
    expect(term.buffer.active.cursorX).toBe(40);
    const request = {requestId: 3, columns: 40, rows: 3, cursorX: 39, cursorY: 2};
    const before = term.buffer.normal.getLine(2)?.translateToString(true);
    expect(observeNativePromptOrigin(term, request)).toEqual({...request,
      cellWidths: text.startsWith('界') ? Array<number>(20).fill(2) : Array<number>(40).fill(1), wrapPending: true});
    expect(observeNativePromptOrigin(term, {...request, cursorX: 38})).toBeUndefined();
    expect(observeNativePromptOrigin(term, {...request, cursorY: 1})).toBeUndefined();
    expect(term.buffer.active.cursorX).toBe(40);expect(term.buffer.active.cursorY).toBe(2);
    expect(term.buffer.normal.getLine(2)?.translateToString(true)).toBe(before);expect(input).toEqual([]);
  } finally {term.dispose();host.remove();}
});

it('starts after the last hard line and preserves spaces and grapheme widths without copying text', async () => {
  const term = new Terminal({cols: 20, rows: 20, allowProposedApi: true});
  const host = document.createElement('div');document.body.append(host);term.open(host);term.loadAddon(new UnicodeGraphemesAddon());
  try {
    await write(term, 'PRIVATE_PREVIOUS_LINE\r\nPS é 👩🏽‍💻 > ');
    const b = term.buffer.active;
    const result = observeNativePromptOrigin(term, {requestId: 2, columns: 20, rows: 20, cursorX: b.cursorX, cursorY: b.cursorY});
    expect(result?.cellWidths).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 1]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(JSON.stringify(result)).not.toContain('👩');
  } finally {term.dispose();host.remove();}
});

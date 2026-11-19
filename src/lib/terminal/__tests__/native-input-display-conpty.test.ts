import {beforeAll, expect, it} from 'vitest';
import {Terminal} from '@xterm/xterm';
import {UnicodeGraphemesAddon} from '@xterm/addon-unicode-graphemes';
import {enableRealCanvas} from '@/tests/real-canvas';
import {attachNativeInputDisplay, NATIVE_INPUT_DISPLAY} from '../native-input-display';

beforeAll(enableRealCanvas);
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
const on = `\x1b]${NATIVE_INPUT_DISPLAY.oscIdentifier};${NATIVE_INPUT_DISPLAY.enterPayload}\x07`;
const off = `\x1b]${NATIVE_INPUT_DISPLAY.oscIdentifier};${NATIVE_INPUT_DISPLAY.exitPayload}\x07`;

function terminal() {
  const value = new Terminal({cols: 199, rows: 53, allowProposedApi: true, reflowCursorLine: false});
  const host = document.createElement('div');document.body.append(host);value.open(host);
  return {value, close: () => {value.dispose();host.remove();}};
}

it('preserves an ordinary long prompt over the observed private ConPTY width changes', async () => {
  const {value, close} = terminal();const previous = value.unicode.activeVersion;
  value.loadAddon(new UnicodeGraphemesAddon());value.unicode.activeVersion = previous;
  const display = attachNativeInputDisplay(value, {...NATIVE_INPUT_DISPLAY, ownedReflowCursorLine: false}, {unicodeVersion: '15-graphemes', unicodeScope: 'session'});
  const prompt = 'PS D:\\owned\\native-display-validation\\long-workspace-name\\artifacts\\tests\\native-input\\integration\\isolated-host\\home>';
  const methods = [value.getSelection, value.selectAll, value.buffer.normal.getLine];const input: string[] = [];const stop = value.onData(data => input.push(data));
  try {
    await write(value, prompt);
    for (const [columns, rows] of [[58,18],[47,33],[199,18],[101,29],[199,53]]) {
      value.resize(columns, rows);value.selectAll();expect(value.getSelection().trimEnd()).toBe(prompt);value.clearSelection();
    }
    expect(value.options.reflowCursorLine).toBe(true);expect(value.unicode.activeVersion).toBe('15-graphemes');
    await write(value, on);expect(value.options.reflowCursorLine).toBe(false);
    await write(value, off);expect(value.options.reflowCursorLine).toBe(true);
    await display.closeAfterPendingOutput();expect(value.options.reflowCursorLine).toBe(false);expect(value.unicode.activeVersion).toBe(previous);
    expect([value.getSelection,value.selectAll,value.buffer.normal.getLine]).toEqual(methods);expect(input).toEqual([]);
  } finally {stop.dispose();display.dispose();close();}
});

it('keeps non-ConPTY bindings on the existing false idle baseline', async () => {
  const {value, close} = terminal();const display = attachNativeInputDisplay(value, NATIVE_INPUT_DISPLAY);
  try {
    expect(value.options.reflowCursorLine).toBe(false);
    await write(value,on);expect(value.options.reflowCursorLine).toBe(true);
    await write(value,off);expect(value.options.reflowCursorLine).toBe(false);
    await display.closeAfterPendingOutput();expect(value.options.reflowCursorLine).toBe(false);
  } finally {display.dispose();close();}
});

it.each([
  {session: false, owned: false},
  {session: true, owned: true},
])('does not infer the private idle policy from a Unicode provider alone: %j', async ({session, owned}) => {
  const {value, close} = terminal();const previous = value.unicode.activeVersion;
  value.loadAddon(new UnicodeGraphemesAddon());value.unicode.activeVersion = previous;
  const display = attachNativeInputDisplay(value, {...NATIVE_INPUT_DISPLAY, ownedReflowCursorLine: owned}, {unicodeVersion: '15-graphemes', ...(session ? {unicodeScope: 'session' as const} : {})});
  try {
    expect(value.options.reflowCursorLine).toBe(false);
    await write(value,on);expect(value.options.reflowCursorLine).toBe(owned);
    await write(value,off);expect(value.options.reflowCursorLine).toBe(false);
    await display.closeAfterPendingOutput();expect(value.options.reflowCursorLine).toBe(false);expect(value.unicode.activeVersion).toBe(previous);
  } finally {display.dispose();close();}
});

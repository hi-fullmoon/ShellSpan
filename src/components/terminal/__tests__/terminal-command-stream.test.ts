import { beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { enableRealCanvas } from '@/tests/real-canvas';
import oldCaptures from '@/tests/fixtures/terminal-command-source-native.json';
import nativeCapture from '@/lib/terminal/__tests__/fixtures/native-selection-reflow.json';
import { attachNativeInputDisplay } from '@/lib/terminal/native-input-display';
import { installTerminalCommandDecorations } from '../registry/terminal-command-decorations';

beforeAll(enableRealCanvas);
const write = (terminal: Terminal, bytes: string | Uint8Array) => new Promise<void>(resolve => terminal.write(bytes, resolve));
const snapshot = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  return {
    lines: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(false)),
    wraps: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.isWrapped),
    cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY],
  };
};

describe('command display is the real PTY stream', () => {
  it.each(oldCaptures.cases)('preserves old output and cursor without projecting $operationId', async capture => {
    const options = { cols: capture.columns, rows: capture.rows, scrollback: 10000, allowProposedApi: true };
    const terminal = new Terminal(options);
    const reference = new Terminal(options);
    const decorations = installTerminalCommandDecorations(terminal, capture.operationId);
    const methods = [terminal.buffer.normal.getLine, terminal.getSelection, terminal.select, terminal.write];
    const inputs: string[] = [];
    const subscription = terminal.onData(data => inputs.push(data));
    try {
      await Promise.all([terminal, reference].map(item => write(item, capture.startup)));
      const bytes = Uint8Array.from(Buffer.from(capture.rawBase64, 'base64'));
      for (let offset = 0; offset < bytes.length; offset += 137) {
        await Promise.all([terminal, reference].map(item => write(item, bytes.subarray(offset, offset + 137))));
        expect(snapshot(terminal), `actual legacy PTY at byte ${offset}`).toEqual(snapshot(reference));
      }
      const before = snapshot(terminal);
      decorations.rebind();
      expect(snapshot(terminal)).toEqual(before);
      expect([terminal.buffer.normal.getLine, terminal.getSelection, terminal.select, terminal.write]).toEqual(methods);
      expect(inputs).toEqual([]);
    } finally {
      subscription.dispose();
      decorations.dispose();
      terminal.dispose();
      reference.dispose();
    }
  });

  it.each([1, 2, 3, 137, nativeCapture.packet.length])('keeps genuine native source, output, selection and search (%i byte reads)', async size => {
    const terminal = new Terminal({ cols: nativeCapture.columns, rows: nativeCapture.rows, scrollback: 20000, allowProposedApi: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    terminal.open(host);
    terminal.loadAddon(new Unicode11Addon());
    const search = new SearchAddon();
    terminal.loadAddon(search);
    const display = attachNativeInputDisplay(terminal, {
      ...nativeCapture.binding, inputMode: 'native-inline',
    }, { unicodeVersion: nativeCapture.binding.unicodeVersion });
    const decorations = installTerminalCommandDecorations(terminal, 'actual-capture');
    const getLine = terminal.buffer.normal.getLine;
    const getSelection = terminal.getSelection;
    const findNext = search.findNext;
    const inputs: string[] = [];
    const subscription = terminal.onData(data => inputs.push(data));
    try {
      const bytes = Uint8Array.from(Buffer.from(nativeCapture.packet.base64, 'base64'));
      expect(bytes.length).toBe(nativeCapture.packet.length);
      // Preserve every real byte fragment and its ordering. Awaiting a fresh
      // event-loop timer per byte measures Windows timer resolution rather than
      // parser fragmentation; the ordered empty write is the completion fence.
      for (let offset = 0; offset < bytes.length; offset += size) terminal.write(bytes.subarray(offset, offset + size));
      await write(terminal, new Uint8Array());
      await display.closeAfterPendingOutput();
      expect(terminal.options.reflowCursorLine).toBe(false);
      for (const text of [nativeCapture.source, 'P3_HISTORY_45', '父Shell-é-👩🏽‍💻']) {
        expect(search.findNext(text), `actual native text: ${text}\nactual rows: ${JSON.stringify(snapshot(terminal))}`).toBe(true);
        expect(terminal.getSelection()).toBe(text);
        for (const columns of nativeCapture.resizeColumns) {
          terminal.options.reflowCursorLine = true;
          terminal.resize(columns, nativeCapture.rows);
          expect(terminal.getSelection()).toBe(text);
        }
        terminal.clearSelection();
      }
      expect(terminal.buffer.normal.getLine).toBe(getLine);
      expect(terminal.getSelection).toBe(getSelection);
      expect(search.findNext).toBe(findNext);
      expect(terminal.options.reflowCursorLine).toBe(true);
      expect(inputs).toEqual([]);
    } finally {
      subscription.dispose();
      decorations.dispose();
      display.dispose();
      terminal.dispose();
      host.remove();
    }
  });
});

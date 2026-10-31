import { spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { enableRealCanvas } from '@/test/real-canvas';
import captures from '@/test/fixtures/terminal-command-source-native.json';
import { installTerminalCommandSource, readNativeTerminalLine } from '../registry/terminal-command-source';

beforeAll(enableRealCanvas);
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
const write = (terminal: Terminal, data: string | Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
const contents = (terminal: Terminal) => Array.from({ length: terminal.buffer.normal.length }, (_, row) =>
  terminal.buffer.normal.getLine(row)!.translateToString(true)).join('\n');
const compact = (text: string) => text.replace(/\s/gu, '');
const outputCases = ['%s', '%s\n'].flatMap(format => [false, true].map(erase => ({ format, erase })));

describe('original command display over real native Bash captures', () => {
  it.each(captures.cases)('keeps the source visible during fragmented input for $operationId ($columns columns)', async capture => {
    const terminal = new Terminal({ cols: capture.columns, rows: capture.rows, scrollback: 10000, allowProposedApi: true });
    disposals.push(() => terminal.dispose());
    await write(terminal, capture.startup);
    let first = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY;
    while (first > 0 && terminal.buffer.normal.getLine(first)?.isWrapped) first--;
    let last = first;
    let complete = false;
    const source = installTerminalCommandSource(terminal, () => [{ id: capture.operationId, source: capture.source,
      submission: capture.submission, first, last: complete ? last : terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, complete }]);
    source.begin(capture.operationId, first);
    disposals.push(() => source.dispose());
    terminal.parser.registerOscHandler(133, data => {
      if (data === 'C') {
        last = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - (terminal.buffer.normal.cursorX === 0 ? 1 : 0);
        complete = true;
      }
      return false;
    });
    const bytes = Uint8Array.from(Buffer.from(capture.rawBase64, 'base64'));
    for (let offset = 0; offset < bytes.length; offset += 137) {
      await write(terminal, bytes.subarray(offset, offset + 137));
      const display = Array.from({ length: terminal.buffer.normal.length - first }, (_, row) =>
        terminal.buffer.normal.getLine(first + row)!.translateToString(true)).join('\n');
      expect(compact(display), `native input at byte ${offset}, cursor ${terminal.buffer.normal.cursorX}/${terminal.buffer.normal.cursorY}, first ${first}: ${JSON.stringify(display)}`).not.toContain(compact('(exit "$?"); builtin eval --'));
    }
  });

  it.each(['partial', 'full'].flatMap(stage => ['el', 'ed', 'overwrite'].map(erase => ({ stage, erase }))))(
    'preserves real output rewriting a verified input row ($stage, $erase)', async ({ stage, erase }) => {
      const capture = captures.cases[0];
      const options = { cols: capture.columns, rows: capture.rows, allowProposedApi: true };
      const terminal = new Terminal(options);
      const baseline = new Terminal(options);
      disposals.push(() => terminal.dispose(), () => baseline.dispose());
      const writeBoth = (bytes: string | Uint8Array) => Promise.all([terminal, baseline].map(item => write(item, bytes)));
      await writeBoth(capture.startup);
      let first = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY;
      while (first > 0 && terminal.buffer.normal.getLine(first)?.isWrapped) first--;
      const prompt = Array.from({ length: terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - first + 1 }, (_, row) =>
        readNativeTerminalLine(terminal, first + row)).join('');
      let complete = false;
      let last = first;
      const source = installTerminalCommandSource(terminal, () => [{ id: capture.operationId,
        source: capture.source, submission: capture.submission, first,
        last: complete ? last : terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, complete }]);
      source.begin(capture.operationId, first);
      disposals.push(() => source.dispose());
      terminal.parser.registerOscHandler(133, data => {
        if (data === 'C') {
          last = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - (terminal.buffer.normal.cursorX === 0 ? 1 : 0);
          complete = true;
        }
        return false;
      });
      const host = document.createElement('div');
      const referenceHost = document.createElement('div');
      document.body.appendChild(host);
      document.body.appendChild(referenceHost);
      disposals.push(() => host.remove(), () => referenceHost.remove());
      terminal.open(host);
      baseline.open(referenceHost);
      const bytes = Buffer.from(capture.rawBase64, 'base64');
      const prefix = capture.submission.slice(0, capture.submission.indexOf(' -- ') + 4);
      const prefixAt = bytes.indexOf(prefix);
      const boundaryAt = bytes.indexOf(Buffer.from('\x1b]133;C\x07'));
      expect(prefixAt).toBeGreaterThan(0);
      expect(boundaryAt).toBeGreaterThan(prefixAt);
      const end = stage === 'full' ? boundaryAt : prefixAt + Buffer.byteLength(prefix);
      await writeBoth(Uint8Array.from(bytes.subarray(0, end)));
      expect(compact(contents(terminal))).not.toContain(compact(prefix));
      let eraseBytes = '';
      if (erase !== 'overwrite') {
        const erased = spawnSync('/usr/bin/tput', [erase], { encoding: 'utf8', env: { ...process.env, TERM: 'xterm-256color' } });
        expect(erased.status).toBe(0);
        eraseBytes = erased.stdout;
      }
      const up = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - first;
      const output = spawnSync('/usr/bin/printf', ['\r\x1b[%dA%s%s%s OUTPUT-RECORD\n',
        String(up), eraseBytes, prompt, capture.submission], { encoding: 'utf8' });
      expect(output.status).toBe(0);
      await writeBoth(output.stdout.replace(/\n/g, '\r\n'));
      const assertOutput = () => {
        expect(contents(terminal)).toBe(contents(baseline));
        terminal.selectAll();
        baseline.selectAll();
        expect(terminal.getSelection()).toBe(baseline.getSelection());
        expect(terminal.getSelection()).toContain('OUTPUT-RECORD');
        terminal.clearSelection();
        baseline.clearSelection();
        expect(terminal.buffer.normal.cursorX).toBe(baseline.buffer.normal.cursorX);
        expect(terminal.buffer.normal.cursorY).toBe(baseline.buffer.normal.cursorY);
      };
      assertOutput();
      await writeBoth('');
      assertOutput();
      if (stage === 'full') {
        await writeBoth(Uint8Array.from(bytes.subarray(boundaryAt)));
        assertOutput();
      }
    });

  it.each(outputCases)('preserves process output before input ($format, erase=$erase)', async ({ format, erase }) => {
    const capture = captures.cases[0];
    const terminal = new Terminal({ cols: 100, rows: 50, allowProposedApi: true });
    disposals.push(() => terminal.dispose());
    await write(terminal, capture.startup);
    const first = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY;
    const source = installTerminalCommandSource(terminal, () => [{ id: capture.operationId, source: capture.source,
      submission: capture.submission, first, last: terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, complete: false }]);
    source.begin(capture.operationId, first);
    disposals.push(() => source.dispose());
    const host = document.createElement('div');
    document.body.appendChild(host);
    disposals.push(() => host.remove());
    terminal.open(host);
    if (erase) {
      const erased = spawnSync('/usr/bin/tput', ['el'], { encoding: 'utf8', env: { ...process.env, TERM: 'xterm-256color' } });
      expect(erased.status).toBe(0);
      await write(terminal, erased.stdout);
    }
    const printed = spawnSync('/usr/bin/printf', [format, capture.submission], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    await write(terminal, printed.stdout.replace(/\n/g, '\r\n'));
    expect(compact(contents(terminal))).toContain(compact(capture.submission));
    terminal.selectAll();
    expect(compact(terminal.getSelection())).toContain(compact(capture.submission));
  });

  it('preserves process output between the actual input echo and C, including later refreshes', async () => {
    const capture = captures.cases[0];
    const terminal = new Terminal({ cols: capture.columns, rows: capture.rows, scrollback: 10000, allowProposedApi: true });
    disposals.push(() => terminal.dispose());
    await write(terminal, capture.startup);
    let first = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY;
    while (first > 0 && terminal.buffer.normal.getLine(first)?.isWrapped) first--;
    let complete = false;
    let last = first;
    const source = installTerminalCommandSource(terminal, () => [{ id: capture.operationId, source: capture.source,
      submission: capture.submission, first, last: complete ? last : terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, complete }]);
    disposals.push(() => source.dispose());
    source.begin(capture.operationId, first);
    terminal.parser.registerOscHandler(133, data => {
      if (data === 'C') {
        last = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - (terminal.buffer.normal.cursorX === 0 ? 1 : 0);
        complete = true;
      }
      return false;
    });
    const bytes = Buffer.from(capture.rawBase64, 'base64');
    const at = bytes.indexOf(Buffer.from('\x1b]133;C\x07'));
    expect(at).toBeGreaterThan(0);
    await write(terminal, Uint8Array.from(bytes.subarray(0, at)));
    const printed = spawnSync('/usr/bin/printf', ['%s\n', capture.submission], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    await write(terminal, printed.stdout.replace(/\n/g, '\r\n'));
    await write(terminal, Uint8Array.from(bytes.subarray(at)));
    for (let refresh = 0; refresh < 2; refresh++) {
      await write(terminal, '');
      expect(compact(contents(terminal))).toContain(compact(capture.source));
      expect(compact(contents(terminal)).split(compact(capture.submission))).toHaveLength(2);
    }
  });

  it.each(captures.cases)('preserves native cells, output and selection for $operationId ($source.length characters)', async capture => {
    const terminal = new Terminal({ cols: capture.columns, rows: capture.rows, scrollback: 10000, allowProposedApi: true });
    const baseline = new Terminal({ cols: capture.columns, rows: capture.rows, scrollback: 10000, allowProposedApi: true });
    disposals.push(() => terminal.dispose(), () => baseline.dispose());
    await Promise.all([terminal, baseline].map(item => write(item, capture.startup)));
    let first = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY;
    while (first > 0 && terminal.buffer.normal.getLine(first)?.isWrapped) first--;
    let last = first;
    let complete = false;
    const source = installTerminalCommandSource(terminal, () => [{ id: capture.operationId,
      source: capture.source, submission: capture.submission, first,
      last: complete ? last : terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, complete }]);
    source.begin(capture.operationId, first);
    const boundary = terminal.parser.registerOscHandler(133, data => {
      if (data === 'C') {
        last = terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY - (terminal.buffer.normal.cursorX === 0 ? 1 : 0);
        complete = true;
      }
      return false;
    });
    disposals.push(() => { boundary.dispose(); source.dispose(); });
    const host = document.createElement('div');
    document.body.appendChild(host);
    disposals.push(() => host.remove());
    // Production installs the adapter before xterm.open(), not after it.
    terminal.open(host);
    const inputs: string[] = [];
    terminal.onData(data => inputs.push(data));
    const bytes = Uint8Array.from(Buffer.from(capture.rawBase64, 'base64'));
    await Promise.all([terminal, baseline].map(item => write(item, bytes)));
    expect(complete).toBe(true);
    const cells = (item: Terminal, row: number) => Array.from({ length: item.cols }, (_, column) => {
      const cell = item.buffer.normal.getLine(row)!.getCell(column)!;
      return [cell.getChars(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isInvisible()];
    });
    for (let row = last + 1; row < baseline.buffer.normal.length; row++) {
      expect(cells(terminal, row)).toEqual(cells(baseline, row));
    }
    const assertNativeUnchanged = () => {
      expect(Array.from({ length: baseline.buffer.normal.length }, (_, row) => readNativeTerminalLine(terminal, row)).join('\n'))
        .toBe(contents(baseline));
      expect(terminal.buffer.normal.cursorX).toBe(baseline.buffer.normal.cursorX);
      expect(terminal.buffer.normal.cursorY).toBe(baseline.buffer.normal.cursorY);
    };
    for (const columns of [40, 32, 100]) {
      terminal.resize(columns, capture.rows);
      baseline.resize(columns, capture.rows);
      assertNativeUnchanged();
      expect(compact(contents(terminal))).toContain(compact(capture.source));
      const input = Array.from({ length: last - first + 1 }, (_, row) =>
        terminal.buffer.normal.getLine(first + row)?.translateToString(true) ?? '').join('\n');
      expect(compact(input)).not.toContain(compact('(exit "$?"); builtin eval --'));
      terminal.selectAll();
      expect(compact(terminal.getSelection())).toContain(compact(capture.source));
      terminal.clearSelection();
    }
    const search = new SearchAddon();
    terminal.loadAddon(search);
    expect(search.findNext('SHELLSPAN_END')).toBe(true);
    expect(terminal.getSelection()).toBe('SHELLSPAN_END');
    terminal.clearSelection();

    // A real process can print the exact internal submission as ordinary
    // output. Only the earlier command input may be projected.
    const printed = spawnSync('/usr/bin/printf', ['%s\n', capture.submission], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    const output = printed.stdout.replace(/\n/g, '\r\n');
    await Promise.all([terminal, baseline].map(item => write(item, output)));
    assertNativeUnchanged();
    expect(compact(contents(terminal))).toContain(compact(capture.submission));
    expect(inputs).toEqual([]);
    // Rebinding retains this exact xterm buffer. Completed display mappings
    // must survive, even though the new transport has no active command.
    source.dispose(true);
    const rebound = installTerminalCommandSource(terminal, () => []);
    disposals.push(() => rebound.dispose());
    for (const columns of [32, 100]) {
      terminal.resize(columns, capture.rows);
      baseline.resize(columns, capture.rows);
      expect(compact(contents(terminal))).toContain(compact(capture.source));
      expect(compact(contents(terminal))).toContain(compact(capture.submission)); // real printf output
      terminal.selectAll();
      expect(compact(terminal.getSelection())).toContain(compact(capture.source));
      terminal.clearSelection();
    }
    rebound.dispose();
    expect(contents(terminal)).toBe(contents(baseline));
  });
});

import {beforeAll, expect, it} from 'vitest';
import {Terminal} from '@xterm/xterm';
import {UnicodeGraphemesAddon} from '@xterm/addon-unicode-graphemes';
import {enableRealCanvas} from '@/tests/real-canvas';
import {nativeDisplayAutoPlan} from './native-display-auto-plan';
import {nativeDisplayHistoryAnchor, nativeDisplayHistoryPlans} from './native-display-history-plan';

beforeAll(enableRealCanvas);
const token = '8cc5e5e7-818b-4124-8878-6f61cf95e701';
const write = (terminal: Terminal, value: string) => new Promise<void>(resolve => terminal.write(value, resolve));

it.each([201, 58, 47])('finds initial physical coordinates for actual Unicode, soft and hard lines at %i columns', async columns => {
  const terminal = new Terminal({cols: columns, rows: 18, allowProposedApi: true});
  const host = document.createElement('div');document.body.append(host);terminal.open(host);
  terminal.loadAddon(new UnicodeGraphemesAddon());terminal.unicode.activeVersion = '15-graphemes';
  const inputs: string[] = [], stop = terminal.onData(value => inputs.push(value));
  const apis = [terminal.getSelection, terminal.select, terminal.buffer.normal.getLine];
  try {
    await write(terminal, nativeDisplayAutoPlan(token, 0, 400).payload.replace(/\n/g, '\r\n') + '\r\n');
    for (const plan of nativeDisplayHistoryPlans(token)) {
      expect(terminal.hasSelection()).toBe(false);
      const anchor = nativeDisplayHistoryAnchor(terminal.buffer.normal, columns, plan.lines);expect(anchor).not.toBeNull();
      expect(terminal.hasSelection()).toBe(false);
      terminal.select(anchor!.column, anchor!.row, anchor!.length);
      expect(terminal.getSelection()).toBe(plan.lines.join('\n'));
      if (plan.kind === 'soft-wrapped') expect(anchor!.physicalRows).toBeGreaterThan(3);
      if (plan.kind === 'hard-lines') expect(anchor!.logicalLines).toBe(2);
      terminal.clearSelection();
    }
    expect(inputs).toEqual([]);expect([terminal.getSelection, terminal.select, terminal.buffer.normal.getLine]).toEqual(apis);
  } finally {stop.dispose();terminal.dispose();host.remove();}
});

it('rejects ambiguous history and Unicode normalization without selecting a substitute', async () => {
  const terminal = new Terminal({cols: 201, rows: 18, allowProposedApi: true});
  try {
    const line = nativeDisplayHistoryPlans(token)[1].lines[0];
    await write(terminal, line + '\r\n');
    expect(nativeDisplayHistoryAnchor(terminal.buffer.normal, 201, [line.normalize('NFC')])).toBeNull();
    await write(terminal, line + '\r\n');
    expect(nativeDisplayHistoryAnchor(terminal.buffer.normal, 201, [line])).toBeNull();
    expect(terminal.hasSelection()).toBe(false);
  } finally {terminal.dispose();}
});

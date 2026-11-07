import type {IBuffer} from '@xterm/xterm';
import {nativeDisplayAutoPlan} from './native-display-auto-plan';

export function nativeDisplayHistoryPlans(token: string) {
  const plan = nativeDisplayAutoPlan(token, 0, 400), prefix = `DA_${token.slice(0, 8)}_0_`;
  return [
    {kind: 'ascii', lines: [plan.lines[1]], topPrefix: plan.lines[1]},
    {kind: 'unicode', lines: [plan.lines[2]], topPrefix: prefix + 'UNICODE_'},
    {kind: 'soft-wrapped', lines: [plan.lines[3]], topPrefix: prefix + 'LONG_'},
    {kind: 'hard-lines', lines: plan.lines.slice(4, 6), topPrefix: plan.lines[4]},
  ] as const;
}

/** Initial coordinates only. Never call to restore or reselect after a resize. */
export function nativeDisplayHistoryAnchor(buffer: Pick<IBuffer, 'length' | 'getLine'>, columns: number, expected: readonly string[]) {
  if (!Number.isInteger(columns) || columns < 20 || columns > 400 || !expected.length || expected.length > 4
    || expected.some(line => !line || /[\r\n]/.test(line))) throw Error('Bounded complete history lines required');
  const logical: {row: number; endRow: number; endColumn: number; text: string}[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const first = buffer.getLine(row);
    if (!first || first.isWrapped) continue;
    let endRow = row, text = '';
    for (;;) {
      const line = buffer.getLine(endRow)!;
      const wrapped = buffer.getLine(endRow + 1)?.isWrapped === true;
      text += line.translateToString(!wrapped);
      if (!wrapped) break;
      endRow++;
    }
    const last = buffer.getLine(endRow)!;let endColumn = 0;
    for (let column = columns - 1; column >= 0; column--) {
      const cell = last.getCell(column);
      if (cell && cell.getChars() && cell.getChars() !== ' ') {endColumn = column + cell.getWidth();break;}
    }
    logical.push({row, endRow, endColumn, text});row = endRow;
  }
  const matches = logical.flatMap((line, index) => expected.every((text, offset) => logical[index + offset]?.text === text)
    ? [{first: line, last: logical[index + expected.length - 1]}] : []);
  if (matches.length !== 1) return null;
  const {first, last} = matches[0];
  return {column: 0, row: first.row, length: (last.endRow - first.row) * columns + last.endColumn,
    expected: expected.join('\n'), logicalLines: expected.length, physicalRows: last.endRow - first.row + 1};
}

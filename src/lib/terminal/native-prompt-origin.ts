import type {Terminal} from '@xterm/xterm';

/** Non-authoritative display data. It must never establish input or execution state. */
export interface NativePromptOriginRequest {
  readonly requestId: number;
  readonly columns: number;
  readonly rows: number;
  readonly cursorX: number;
  readonly cursorY: number;
}

export interface NativePromptOriginObservation extends NativePromptOriginRequest {
  readonly cellWidths: readonly (1 | 2)[];
  readonly wrapPending: boolean;
}

const MAX_ORIGIN_CELLS = 65_536;
const boundedInteger = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Returns no text and does not move the cursor, alter the buffer, or emit input. */
export function observeNativePromptOrigin(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'buffer'>,
  request: NativePromptOriginRequest,
): NativePromptOriginObservation | undefined {
  if (!request || typeof request !== 'object' || !boundedInteger(request.requestId, 1, 0x7fffffff)
    || !boundedInteger(request.columns, 1, 65_535) || !boundedInteger(request.rows, 1, 65_535)
    || !boundedInteger(request.cursorX, 0, request.columns - 1) || !boundedInteger(request.cursorY, 0, request.rows - 1)
    || terminal.cols !== request.columns || terminal.rows !== request.rows) return undefined;
  const buffer = terminal.buffer.active;
  // xterm exposes the pending-wrap position one past the final cell. Console
  // reports that same visible cursor in the final column. Keep this explicit.
  const wrapPending = buffer.cursorX === request.columns && request.cursorX === request.columns - 1;
  if (buffer.type !== 'normal' || (!wrapPending && buffer.cursorX !== request.cursorX) || buffer.cursorY !== request.cursorY) return undefined;
  const endRow = buffer.baseY + buffer.cursorY;
  let startRow = endRow;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) {
    if ((endRow - startRow + 1) * request.columns > MAX_ORIGIN_CELLS) return undefined;
    startRow--;
  }
  const cellWidths: (1 | 2)[] = [];
  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) return undefined;
    let limit = row === endRow ? buffer.cursorX : request.columns;
    if (row < endRow) {
      const last = line.getCell(request.columns - 1), next = buffer.getLine(row + 1)?.getCell(0);
      // A wide grapheme moved to the next row leaves an unused cell behind.
      if (last?.getWidth() === 1 && last.getChars() === '' && next?.getWidth() === 2) limit--;
    }
    for (let column = 0; column < limit;) {
      const cell = line.getCell(column);
      if (!cell) return undefined;
      const width = cell.getWidth();
      if (width === 0) {column++;continue;}
      if ((width !== 1 && width !== 2) || column + width > limit || cellWidths.length >= MAX_ORIGIN_CELLS) return undefined;
      cellWidths.push(width);column += width;
    }
  }
  return {requestId: request.requestId, columns: request.columns, rows: request.rows,
    cursorX: request.cursorX, cursorY: request.cursorY, cellWidths, wrapPending};
}

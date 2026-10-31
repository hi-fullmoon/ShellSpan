import { Terminal, type IBufferCell, type IBufferLine, type IDisposable, type IMarker } from '@xterm/xterm';

export interface TerminalCommandSourceRange {
  readonly id: string;
  readonly source: string;
  readonly submission: string;
  readonly first: number;
  readonly last: number;
  readonly complete: boolean;
}

// xterm 6 has no public text-projection API. Keep the version-specific access
// here: the parser, cursor, markers and stored native lines are never modified.
// xterm's own parser lays out the source (including wide/combining characters).
interface NativeLine {
  readonly length: number;
  isWrapped: boolean;
  clone(): NativeLine;
  fill(cell: IBufferCell): void;
  copyCellsFrom(source: NativeLine, sourceColumn: number, targetColumn: number, length: number): void;
  loadCell(column: number, cell: IBufferCell): IBufferCell;
  translateToString(trim?: boolean, start?: number, end?: number): string;
}
interface NativeBuffer {
  x: number;
  y: number;
  ybase: number;
  lines: { length: number; get(index: number): NativeLine | undefined; set(index: number, line: NativeLine): void };
}
interface Renderer { renderRows(start: number, end: number): void }
interface SelectionAccess {
  readonly selectionText: string;
  _getWordAt(coords: [number, number], whitespace: boolean, above?: boolean, below?: boolean): unknown;
}
interface ProjectionAccess {
  _core: {
    _bufferService: { buffer: NativeBuffer };
    _inputHandler: { parse(data: string): void | Promise<boolean> };
    _selectionService?: SelectionAccess;
    _renderService?: {
      _renderer: { value?: Renderer };
      setRenderer(renderer: Renderer): void;
    };
  };
}

function native(terminal: Terminal): ProjectionAccess['_core'] {
  return (terminal as unknown as ProjectionAccess)._core;
}

/** Native bytes stay available to redraw synchronization, independently of display. */
export function readNativeTerminalLine(terminal: Terminal, index: number): string {
  return native(terminal)._bufferService.buffer.lines.get(index)?.translateToString(true) ?? '';
}

function literalSource(source: string): string {
  return source.replace(/[\x00-\x1f\x7f-\x9f]/gu, character => {
    if (character === '\n') return '\r\n';
    if (character === '\t') return '\t';
    if (character.charCodeAt(0) > 127) return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    return character === '\x7f' ? '^?' : `^${String.fromCharCode(character.charCodeAt(0) + 64)}`;
  });
}

// Readline displays tabs as spacing and soft-wraps long physical lines. Match
// the supplied literal submission, never prompts or arbitrary shell syntax.
function comparable(text: string): string {
  return text.replace(/\r/gu, '^M').replace(/\s/gu, '');
}

interface SavedSource {
  source: string;
  submission: string;
  target: string;
  offset: number;
  anchor: IMarker;
  tail: IMarker;
  columns?: number;
  cells?: ReadonlyMap<NativeLine, NativeLine>;
}
interface VerifiedEcho {
  column: number;
  length: number;
  rows: Array<{ line: NativeLine; text: string; wrapped: boolean; revision: number }>;
}
const histories = new WeakMap<Terminal, SavedSource[]>();

export function installTerminalCommandSource(
  terminal: Terminal,
  ranges: () => readonly TerminalCommandSourceRange[],
): IDisposable & { dispose(preserveHistory?: boolean): void; refresh(): void; begin(id: string, row: number): void } {
  const scratch = new Terminal({ cols: terminal.cols, rows: terminal.rows, scrollback: 32768, allowProposedApi: true });
  const projected = new Map<NativeLine, NativeLine>();
  const completed = new Map<string | symbol, SavedSource>((histories.get(terminal) ?? []).map(record => [Symbol(), record]));
  histories.delete(terminal);
  const origins = new Map<string, { marker?: IMarker; locked: boolean; prompt?: string;
    erased: WeakSet<NativeLine>; echoes: WeakMap<NativeLine, VerifiedEcho>;
    revisions: WeakMap<NativeLine, number>; confirmed: boolean; sawErase: boolean }>();
  const core = native(terminal);
  let rendererService: ProjectionAccess['_core']['_renderService'];
  let setRenderer: NonNullable<typeof rendererService>['setRenderer'] | undefined;
  const wrappedRenderers = new Map<Renderer, Renderer['renderRows']>();
  let restoreSelection: (() => void) | undefined;
  let rendering = false;
  let disposed = false;

  const withSourceCells = <T,>(read: () => T): T => {
    if (rendering || terminal.buffer.active.type !== 'normal' || projected.size === 0) return read();
    const buffer = core._bufferService.buffer;
    const saved: Array<[number, NativeLine]> = [];
    for (let row = 0; row < buffer.lines.length; row++) {
      const line = buffer.lines.get(row);
      const replacement = line && projected.get(line);
      if (line && replacement) { saved.push([row, line]); buffer.lines.set(row, replacement); }
    }
    rendering = true;
    try { return read(); }
    finally {
      for (const [row, line] of saved) buffer.lines.set(row, line);
      rendering = false;
    }
  };
  const wrapRenderer = (renderer: Renderer) => {
    if (wrappedRenderers.has(renderer)) return;
    const renderRows = renderer.renderRows;
    wrappedRenderers.set(renderer, renderRows);
    renderer.renderRows = (start, end) => withSourceCells(() => renderRows.call(renderer, start, end));
  };
  const installRenderer = () => {
    if (rendererService || !core._renderService) return;
    rendererService = core._renderService;
    const original = rendererService.setRenderer;
    setRenderer = original;
    rendererService.setRenderer = function (renderer) {
      wrapRenderer(renderer);
      original.call(this, renderer);
    };
    if (rendererService._renderer.value) wrapRenderer(rendererService._renderer.value);
    const selection = core._selectionService;
    if (selection) {
      const own = Object.getOwnPropertyDescriptor(selection, 'selectionText');
      const descriptor = own ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(selection), 'selectionText');
      const read = descriptor?.get as (() => string) | undefined;
      const wordAt = selection._getWordAt;
      if (read) Object.defineProperty(selection, 'selectionText', {
        configurable: true, get: () => withSourceCells(() => read.call(selection)),
      });
      selection._getWordAt = (...args) => withSourceCells(() => wordAt.apply(selection, args));
      restoreSelection = () => {
        if (own) Object.defineProperty(selection, 'selectionText', own);
        else Reflect.deleteProperty(selection, 'selectionText');
        selection._getWordAt = wordAt;
      };
    }
  };
  const open = terminal.open;
  terminal.open = function (parent) { open.call(this, parent); installRenderer(); };
  installRenderer();

  const normal = terminal.buffer.normal;
  const getLine = normal.getLine;
  normal.getLine = function (index): IBufferLine | undefined {
    const line = getLine.call(this, index);
    const raw = core._bufferService.buffer.lines.get(index);
    const replacement = raw && projected.get(raw);
    if (!line || !replacement || terminal.buffer.active.type !== 'normal') return line;
    return {
      length: replacement.length, isWrapped: replacement.isWrapped,
      getCell: (column, cell) => column < 0 || column >= replacement.length ? undefined
        : replacement.loadCell(column, cell ?? normal.getNullCell()),
      translateToString: (trim, start, end) => replacement.translateToString(trim, start, end),
    };
  };
  const getSelection = terminal.getSelection;
  terminal.getSelection = () => withSourceCells(() => getSelection.call(terminal));

  const begin = (id: string, row: number) => {
    if (origins.get(id)?.locked || completed.has(id)) return;
    origins.get(id)?.marker?.dispose();
    const buffer = core._bufferService.buffer;
    // Anchor before the editable prompt: Readline may erase every input row.
    const marker = row > 0 ? terminal.registerMarker(row - 1 - buffer.ybase - buffer.y) : undefined;
    let prompt = '';
    for (let line = row; line <= buffer.ybase + buffer.y; line++) {
      prompt += buffer.lines.get(line)?.translateToString(true, 0, line === buffer.ybase + buffer.y ? buffer.x : undefined) ?? '';
    }
    origins.set(id, { marker, locked: false, prompt: comparable(prompt) || undefined,
      erased: new WeakSet(), echoes: new WeakMap(), revisions: new WeakMap(), confirmed: false, sawErase: false });
    while (origins.size > 256) {
      const oldest = origins.keys().next().value!;
      origins.get(oldest)?.marker?.dispose(); origins.delete(oldest);
    }
  };

  const refresh = () => {
    projected.clear();
    if (terminal.buffer.active.type !== 'normal') return;
    const buffer = core._bufferService.buffer;
    for (const [id, record] of completed) {
      if (!record.anchor.isDisposed && !record.tail.isDisposed) continue;
      record.anchor.dispose(); record.tail.dispose(); completed.delete(id);
    }
    const current = ranges().filter(range => !completed.has(range.id));
    const retained = [...completed].flatMap(([id, record]) => {
      let last = record.tail.line;
      while (last + 1 < buffer.lines.length && buffer.lines.get(last + 1)?.isWrapped) last++;
      if (last < buffer.ybase && record.columns === terminal.cols && record.cells) {
        for (const [line, replacement] of record.cells) projected.set(line, replacement);
        return [];
      }
      return [{ id, source: record.source, submission: record.submission, first: record.anchor.line,
        target: record.target, offset: record.offset, last, complete: true, retained: true }];
    });
    for (const range of [...current.map(range => ({ ...range, target: comparable(range.submission), offset: 0, retained: false })), ...retained]) {
      if (!range.source || range.source === range.submission) continue;
      const expected = range.target;
      if (!expected) continue;
      const last = Math.min(range.last, buffer.lines.length - 1);
      const origin = typeof range.id === 'string' ? origins.get(range.id) : undefined;
      const first = Math.max(0, range.retained ? range.first : origin
        ? origin.marker && !origin.marker.isDisposed ? origin.marker.line + 1 : 0 : range.first);
      const positions: Array<{ row: number; column: number }> = [];
      let text = '';
      const cell = normal.getNullCell();
      for (let row = first; row <= last; row++) {
        const line = buffer.lines.get(row);
        if (!line) continue;
        for (let column = 0; column < terminal.cols; column++) {
          const value = line.loadCell(column, cell);
          if (value.getWidth() === 0) continue;
          for (const character of value.getChars()) {
            if (/\s/u.test(character)) continue;
            text += character;
            for (let unit = 0; unit < character.length; unit++) positions.push({ row, column });
          }
        }
      }
      const matches: Array<{ at: number; length: number }> = [];
      // Oversized Readline redraws can preserve earlier input prefixes in
      // scrollback. They belong to the same delimited operation, too.
      const prefix = expected.slice(0, Math.min(32, expected.length));
      for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + prefix.length)) {
        let length = prefix.length;
        while (length < expected.length && text[at + length] === expected[length]) length++;
        matches.push({ at, length });
      }
      if (!range.complete && !matches.some(match => match.at + match.length === text.length)) {
        for (let length = Math.min(24, expected.length); length > 0; length--) {
          const at = text.lastIndexOf(expected.slice(0, length));
          if (at >= 0 && expected.startsWith(text.slice(at))) {
            matches.push({ at, length: text.length - at });
            break;
          }
        }
      }
      if (matches.length === 0) continue;
      const fullCandidates = matches.filter(match => match.length === expected.length);
      const candidateFinal = fullCandidates[fullCandidates.length - 1];
      const verified = matches.filter(match => {
        if (range.retained) return match.at === range.offset && match.length === expected.length;
        // Shells without repainting may use one complete echo immediately
        // before C. A repainting editor must prove the prompt/erase lineage.
        if (range.complete && match === candidateFinal && !origin?.sawErase
          && positions[match.at + match.length - 1]?.row === last) return true;
        if (!origin?.prompt) return false;
        const start = positions[match.at];
        const end = positions[match.at + match.length - 1];
        if (!start || !end) return false;
        let logical = start.row;
        while (logical > first && buffer.lines.get(logical)?.isWrapped) logical--;
        const line = buffer.lines.get(logical);
        if (!line || !origin.erased.has(line)) return false;
        let prompt = '';
        for (let row = logical; row <= start.row; row++) {
          prompt += buffer.lines.get(row)?.translateToString(true, 0, row === start.row ? start.column : undefined) ?? '';
        }
        if (comparable(prompt) !== origin.prompt) return false;
        const echo = origin.echoes.get(line);
        if (echo?.column === start.column && echo.length >= match.length && echo.rows.length >= end.row - logical + 1
          && echo.rows.slice(0, end.row - logical + 1).every((saved, index) => buffer.lines.get(logical + index) === saved.line
            && saved.line.translateToString(false) === saved.text && saved.line.isWrapped === saved.wrapped
            && (origin.revisions.get(saved.line) ?? 0) === saved.revision)) return true;
        // A coalesced capture may contain no earlier write/paint checkpoint.
        // A rewritten, previously verified row must still prove its new echo.
        if (range.complete && !origin.confirmed) return true;
        if (range.complete && (match !== candidateFinal || end.row !== last)) return false;
        const cursorRow = range.complete ? last : buffer.ybase + buffer.y;
        // A split Readline clear can leave CR at the start of the last input
        // row before K arrives. Revalidate that exact tail at the current row;
        // unrelated output after the match must never inherit this allowance.
        const clearingTail = echo && buffer.x === 0 && end.row === cursorRow
          && match.at + match.length === text.length;
        const cursorColumn = range.complete || clearingTail ? terminal.cols : buffer.x;
        const endColumn = end.column + buffer.lines.get(end.row)!.loadCell(end.column, cell).getWidth();
        if (end.row > cursorRow || (end.row === cursorRow && endColumn > cursorColumn)) return false;
        // Matching ignores editor whitespace. A PTY read may end after a
        // space, tab or newline, so its last character need not touch the
        // cursor. Require the entire remaining span to be whitespace instead.
        for (let row = end.row; row <= cursorRow; row++) {
          const suffix = buffer.lines.get(row)?.translateToString(false,
            row === end.row ? endColumn : 0, row === cursorRow ? cursorColumn : undefined) ?? '';
          if (/\S/u.test(suffix)) return false;
        }
        // Readline can leave this verified input fragment in scrollback while
        // repainting a longer version. Keep its display independent of the
        // moving cursor, while still rechecking its prompt and native prefix.
        origin.confirmed = true;
        origin.echoes.set(line, { column: start.column, length: match.length,
          rows: Array.from({ length: end.row - logical + 1 }, (_, index) => {
            const row = buffer.lines.get(logical + index)!;
            return { line: row, text: row.translateToString(false), wrapped: row.isWrapped,
              revision: origin.revisions.get(row) ?? 0 };
          }) });
        return true;
      });
      if (verified.length === 0) continue;
      const verifiedFull = verified.filter(match => match.length === expected.length);
      const final = verifiedFull[verifiedFull.length - 1];
      if (origin) origin.locked = true;
      for (const match of verified) {
        const start = positions[match.at];
        const end = positions[match.at + match.length - 1];
        if (!start || !end) continue;
        let record = range.retained ? completed.get(range.id) : undefined;
        if (range.complete && !range.retained && final) {
          let head = start.row;
          let tailRow = end.row;
          while (head > 0 && buffer.lines.get(head)?.isWrapped) head--;
          while (tailRow > 0 && buffer.lines.get(tailRow)?.isWrapped) tailRow--;
          const anchor = terminal.registerMarker(head - buffer.ybase - buffer.y);
          const tail = terminal.registerMarker(tailRow - buffer.ybase - buffer.y);
          const firstCharacter = positions.findIndex(position => position.row >= head);
          if (anchor && tail) {
            record = { source: range.source, submission: range.submission, anchor, tail,
              target: expected.slice(0, match.length), offset: match.at - firstCharacter };
            completed.set(match === final ? range.id : Symbol(), record);
          } else { anchor?.dispose(); tail?.dispose(); }
        }
        const cells = new Map<NativeLine, NativeLine>();
        scratch.resize(terminal.cols, terminal.rows);
        scratch.reset();
        const sourceBuffer = native(scratch)._bufferService.buffer;
        const originalFirst = buffer.lines.get(start.row)!;
        sourceBuffer.lines.get(0)!.copyCellsFrom(originalFirst, 0, 0, start.column);
        sourceBuffer.x = start.column;
        native(scratch)._inputHandler.parse(literalSource(range.source));
        const blank = sourceBuffer.lines.get(0)!.clone();
        blank.fill(scratch.buffer.normal.getNullCell());
        for (let row = start.row; row <= end.row; row++) {
          const original = buffer.lines.get(row)!;
          const replacement = (projected.get(original) ?? original).clone();
          const source = sourceBuffer.lines.get(row - start.row);
          const column = row === start.row ? start.column : 0;
          const limit = row === end.row ? end.column + original.loadCell(end.column, cell).getWidth() : terminal.cols;
          if (source) replacement.copyCellsFrom(source, column, column, limit - column);
          else {
            // A source shorter than its quoted envelope leaves empty input cells;
            // process output retains its original rows and ANSI attributes.
            replacement.copyCellsFrom(blank, 0, column, limit - column);
          }
          if (row > start.row) replacement.isWrapped = source?.isWrapped ?? false;
          projected.set(original, replacement);
          cells.set(original, replacement);
        }
        if (record) {
          record.columns = terminal.cols;
          // Normal terminal commands cannot edit scrollback. Reflow or visible
          // input rows must be rechecked against native cells before caching.
          record.cells = last < buffer.ybase ? cells : undefined;
        }
      }
      if (range.complete && final && typeof range.id === 'string') {
        origin?.marker?.dispose(); origins.delete(range.id);
      }
    }
  };
  const observeErase = (all: boolean) => {
    if (terminal.buffer.active.type !== 'normal') return false;
    const buffer = core._bufferService.buffer;
    for (const range of ranges()) {
      const origin = origins.get(range.id);
      if (!origin || range.complete) continue;
      // Erasing and repainting the same bytes must not inherit an earlier
      // input confirmation merely because xterm reused its BufferLine object.
      for (let row = all ? buffer.ybase : buffer.ybase + buffer.y;
        row <= (all ? buffer.ybase + terminal.rows - 1 : buffer.ybase + buffer.y); row++) {
        const line = buffer.lines.get(row);
        if (line) origin.revisions.set(line, (origin.revisions.get(line) ?? 0) + 1);
      }
      if (!all && buffer.x !== 0) continue;
      origin.sawErase = true;
      let logical = buffer.ybase + buffer.y;
      while (logical > 0 && buffer.lines.get(logical)?.isWrapped) logical--;
      if (!origin.prompt) {
        let prompt = '';
        for (let row = logical; row <= buffer.ybase + buffer.y; row++) prompt += buffer.lines.get(row)?.translateToString(true) ?? '';
        origin.prompt = comparable(prompt) || undefined;
      }
      for (let row = all ? buffer.ybase : logical; row <= (all ? buffer.ybase + terminal.rows - 1 : buffer.ybase + buffer.y); row++) {
        const line = buffer.lines.get(row);
        if (line) origin.erased.add(line);
      }
    }
    return false;
  };
  const subscriptions = [terminal.onWriteParsed(refresh), terminal.onResize(refresh), terminal.buffer.onBufferChange(refresh),
    terminal.parser.registerCsiHandler({ final: 'K' }, () => observeErase(false)),
    terminal.parser.registerCsiHandler({ final: 'J' }, () => observeErase(true))];
  refresh();
  return {
    refresh,
    begin,
    dispose(preserveHistory = false) {
      if (disposed) return;
      disposed = true;
      subscriptions.forEach(subscription => subscription.dispose());
      normal.getLine = getLine;
      terminal.getSelection = getSelection;
      terminal.open = open;
      restoreSelection?.();
      if (rendererService && setRenderer) rendererService.setRenderer = setRenderer;
      for (const [renderer, renderRows] of wrappedRenderers) renderer.renderRows = renderRows;
      if (preserveHistory) histories.set(terminal, [...completed.values()]);
      else for (const record of completed.values()) { record.anchor.dispose(); record.tail.dispose(); }
      for (const origin of origins.values()) origin.marker?.dispose();
      origins.clear();
      completed.clear();
      projected.clear();
      scratch.dispose();
    },
  };
}

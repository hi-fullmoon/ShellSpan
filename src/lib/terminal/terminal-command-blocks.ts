import type { IMarker, Terminal } from '@xterm/xterm';
import type { TerminalCommandLifecycleEvent } from '@/types';

interface Position {
  marker: IMarker;
  column: number;
}

export interface TerminalCommandBlock {
  id: number;
  prompt?: IMarker;
  output?: Position;
  end?: Position;
  lifecycle?: TerminalCommandLifecycleEvent;
}

const MAX_BLOCKS = 500;
const COMMAND_BOUNDARY = /^(C|D;-?\d+);ShellSpan=([1-9]\d*)$/;

export function createTerminalCommandBlocks(terminal: Terminal) {
  const blocks = new Map<number, TerminalCommandBlock>();
  const listeners = new Set<() => void>();
  let pendingPrompt: IMarker | undefined;
  let columns = terminal.cols;
  let revision = 0;
  const publish = () => {
    revision++;
    listeners.forEach((listener) => listener());
  };
  const removeSilent = (id: number): boolean => {
    const block = blocks.get(id);
    if (!block) return false;
    blocks.delete(id);
    block.prompt?.dispose();
    block.output?.marker.dispose();
    block.end?.marker.dispose();
    return true;
  };
  const remove = (id: number) => {
    if (removeSilent(id)) publish();
  };
  const get = (id: number): TerminalCommandBlock => {
    const existing = blocks.get(id);
    if (existing) return existing;
    if (blocks.size >= MAX_BLOCKS) {
      const oldest = blocks.keys().next().value;
      if (oldest !== undefined) remove(oldest);
    }
    const block = { id };
    blocks.set(id, block);
    return block;
  };
  const register = (id: number): Position | undefined => {
    const marker = terminal.registerMarker(0);
    if (!marker) return undefined;
    marker.onDispose(() => remove(id));
    return { marker, column: terminal.buffer.active.cursorX };
  };
  const osc = terminal.parser.registerOscHandler(133, (payload) => {
    if (terminal.buffer.active.type !== 'normal') return false;
    if (payload === 'A') {
      pendingPrompt?.dispose();
      pendingPrompt = terminal.registerMarker(0);
      return false;
    }
    const match = COMMAND_BOUNDARY.exec(payload);
    if (!match) return false;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id)) return false;
    if (match[1] === 'C') {
      const block = get(id);
      if (!block.output) {
        block.prompt = pendingPrompt && !pendingPrompt.isDisposed ? pendingPrompt : terminal.registerMarker(0);
        pendingPrompt = undefined;
        block.prompt?.onDispose(() => remove(id));
        block.output = register(id);
        publish();
      }
    } else {
      const block = blocks.get(id);
      if (block?.output && !block.end) {
        block.end = register(id);
        publish();
      }
    }
    return false;
  });
  const resize = terminal.onResize(({ cols }) => {
    if (columns === cols) return;
    columns = cols;
    // xterm reflows its markers by row. Line-aligned boundaries (column 0)
    // remain valid across horizontal reflow, whereas mid-line column offsets
    // no longer identify the original span.
    for (const [id, block] of [...blocks.entries()]) {
      const hasMidLineBoundary = (block.output !== undefined && block.output.column > 0)
        || (block.end !== undefined && block.end.column > 0);
      if (hasMidLineBoundary) removeSilent(id);
    }
    publish();
  });

  return {
    update(event: TerminalCommandLifecycleEvent): void {
      const block = get(event.commandId);
      if (block.lifecycle?.phase === 'completed') return;
      block.lifecycle = event;
      publish();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRevision: () => revision,
    list: () => [...blocks.values()],
    dispose() {
      listeners.clear();
      osc.dispose();
      resize.dispose();
      pendingPrompt?.dispose();
      [...blocks.keys()].forEach(removeSilent);
    },
  };
}

export type TerminalCommandBlocks = ReturnType<typeof createTerminalCommandBlocks>;

export function readTerminalCommandOutput(terminal: Terminal, block: TerminalCommandBlock): string | null {
  const { output, end } = block;
  const buffer = terminal.buffer.active;
  if (!output || !end || output.marker.isDisposed || end.marker.isDisposed
    || end.marker.line < output.marker.line || buffer.type !== 'normal') return null;
  const chunks: string[] = [];
  for (let index = output.marker.line; index <= end.marker.line; index++) {
    const line = buffer.getLine(index);
    if (!line) return null;
    const start = index === output.marker.line ? output.column : 0;
    const stop = index === end.marker.line ? end.column : undefined;
    const wrapped = index < end.marker.line && buffer.getLine(index + 1)?.isWrapped;
    chunks.push(line.translateToString(!wrapped, start, stop));
    if (!wrapped && index < end.marker.line) chunks.push('\n');
  }
  return chunks.join('').replace(/\n$/, '');
}

export function jumpToTerminalCommand(terminal: Terminal, blocks: readonly TerminalCommandBlock[], previous: boolean): void {
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal') return;
  const lines = blocks.flatMap((block) => block.prompt && !block.prompt.isDisposed ? [block.prompt.line] : [])
    .sort((first, second) => first - second);
  const target = previous
    ? [...lines].reverse().find((line) => line < buffer.viewportY)
    : lines.find((line) => line > buffer.viewportY);
  if (target !== undefined) terminal.scrollToLine(target);
}

export function shouldNotifyTerminalCommand(event: TerminalCommandLifecycleEvent, threshold: number, activeVisible: boolean): boolean {
  return threshold > 0 && !activeVisible && event.phase === 'completed'
    && ((event.exitCode !== undefined && event.exitCode !== 0) || (event.durationMs ?? 0) >= threshold * 1000);
}

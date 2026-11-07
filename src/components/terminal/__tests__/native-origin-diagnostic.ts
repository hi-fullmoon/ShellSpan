import type {Terminal} from '@xterm/xterm';
import type {TerminalPromptOriginRequest} from '@/lib/ipc/tauri';

interface GeometrySample {
  phase: 'event' | 'drained' | 'later' | 'deadline';
  at: number;
  columns: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  baseY: number;
  bufferType: 'normal' | 'alternate';
}
export interface NativeOriginDiagnosticRecord {
  requestIndex: number;
  geometry: TerminalPromptOriginRequest['geometry'];
  samples: GeometrySample[];
}

/** Acceptance-only numeric sampling. No text, cells, input, or lifecycle facts. */
export function createNativeOriginDiagnostic(terminal: Pick<Terminal, 'cols' | 'rows' | 'buffer' | 'write'>) {
  const records: NativeOriginDiagnosticRecord[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const sample = (record: NativeOriginDiagnosticRecord, phase: GeometrySample['phase']) => {
    if (disposed) return;
    const buffer = terminal.buffer.active;
    record.samples.push({phase, at: Date.now(), columns: terminal.cols, rows: terminal.rows,
      cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY, bufferType: buffer.type});
  };
  const later = (record: NativeOriginDiagnosticRecord, phase: GeometrySample['phase'], delay: number) => {
    const timer = setTimeout(() => {timers.delete(timer);sample(record, phase);}, delay);
    timers.add(timer);
  };
  return {
    records,
    observe(request: TerminalPromptOriginRequest) {
      if (disposed || records.length >= 32) return;
      const record: NativeOriginDiagnosticRecord = {requestIndex: request.requestIndex,
        geometry: {...request.geometry}, samples: []};
      records.push(record);
      sample(record, 'event');
      terminal.write('', () => sample(record, 'drained'));
      later(record, 'later', 250);
      later(record, 'deadline', Math.max(1, request.timeoutMs - 100));
    },
    dispose() {disposed = true;for (const timer of timers) clearTimeout(timer);timers.clear();},
  };
}

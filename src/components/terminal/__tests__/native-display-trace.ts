import type {Terminal, ITerminalOptions} from '@xterm/xterm';
import type {SessionPtyInfo} from '@/types';

export interface NativeDisplayTraceInitial {
  columns: number;
  rows: number;
  empty: boolean;
  unicodeVersion: string;
  nativeDisplayBinding: SessionPtyInfo['nativeDisplayBinding'];
  options: Pick<ITerminalOptions, 'windowsPty' | 'scrollback' | 'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'reflowCursorLine'>;
}
export type NativeDisplayTraceAction =
  | {kind: 'selectAll'} | {kind: 'clearSelection'}
  | {kind: 'select'; column: number; row: number; length: number}
  | {kind: 'scrollToLine'; row: number} | {kind: 'scrollToBottom'}
  | {kind: 'searchNext'; term: string};
type TraceEvent =
  | {type: 'output'; sequence: number; offset: number; characters: number; source: 'session' | 'local'}
  | {type: 'resize'; columns: number; rows: number; outputSequence: number; parsedThrough: number}
  | {type: 'action'; action: NativeDisplayTraceAction; outputSequence: number; parsedThrough: number}
  | {type: 'checkpoint'; label: string; outputSequence: number; parsedThrough: number; stateSha256: string; stateCharacters: number; stateJson: string};

/** Complete public display state; no source, input, acceptance or lifecycle authority. */
export function nativeDisplayTraceState(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  return JSON.stringify({columns: terminal.cols, rows: terminal.rows, type: buffer.type,
    cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY, viewportY: buffer.viewportY,
    selection: terminal.getSelection(), selectionPosition: terminal.getSelectionPosition() ?? null,
    lines: Array.from({length: buffer.length}, (_, row) => {
      const line = buffer.getLine(row);
      if (!line) throw Error('Public display line disappeared during snapshot');
      return {wrapped: line.isWrapped, text: line.translateToString(false)};
    })});
}

export class NativeDisplayTrace {
  private events: TraceEvent[] = [];
  private outputSequence = -1;
  private parsedThrough = -1;
  private characters = 0;
  private issues: string[] = [];
  constructor(readonly initial: NativeDisplayTraceInitial) {
    if (!initial.empty) this.issue('Initial display was not empty when observation began');
  }
  private issue(message: string) {if (!this.issues.includes(message)) this.issues.push(message);}
  private append(event: TraceEvent) {
    if (this.events.length >= 40000) {this.issue('Display event bound exceeded');return;}
    this.events.push(event);
  }
  output(value: string, source: 'session' | 'local' = 'session'): number {
    if (!value || this.characters + value.length > 900000) {this.issue('Decoded output bound violated');return -1;}
    const sequence = ++this.outputSequence;
    this.append({type: 'output', sequence, offset: this.characters, characters: value.length, source});
    this.characters += value.length;return sequence;
  }
  parsed(sequence: number) {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > this.outputSequence) {this.issue('Unknown parsed output sequence');return;}
    this.parsedThrough = Math.max(this.parsedThrough, sequence);
  }
  resize(columns: number, rows: number) {
    if (this.parsedThrough !== this.outputSequence) this.issue('Resize occurred before previously observed output was parsed');
    this.append({type: 'resize', columns, rows, outputSequence: this.outputSequence, parsedThrough: this.parsedThrough});
  }
  action(action: NativeDisplayTraceAction) {
    this.append({type: 'action', action, outputSequence: this.outputSequence, parsedThrough: this.parsedThrough});
  }
  async checkpoint(label: string, state: string) {
    if (this.parsedThrough !== this.outputSequence) this.issue('Checkpoint occurred before previously observed output was parsed');
    const event: Extract<TraceEvent, {type: 'checkpoint'}> = {type: 'checkpoint', label, outputSequence: this.outputSequence, parsedThrough: this.parsedThrough, stateSha256: '', stateCharacters: state.length, stateJson: state};
    this.append(event);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
    event.stateSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  snapshot(raw: string) {
    if (raw.length !== this.characters) this.issue('Observed decoded output does not match trace range');
    if (this.parsedThrough !== this.outputSequence) this.issue('Final observed output was not parsed');
    return {version: 2, streamKind: 'actual-visible-output', offsetUnit: 'UTF16-code-units', initial: this.initial, events: this.events,
      outputCharacters: this.characters, outputEvents: this.outputSequence + 1, issues: [...this.issues],
      replayable: this.issues.length === 0, inputOrLifecycleAuthority: false, originalWireBytesClaimed: false};
  }
}

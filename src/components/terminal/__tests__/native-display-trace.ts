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
  | {kind: 'searchNext'; term: string}
  | {kind: 'paste'; data: string}
  | {kind: 'unicodeVersion'; version: string; register?: 'graphemes'}
  /** Observed production rebind request. Replay drains the retired display,
   * writes its captured local boundary once, then attaches this actual scope. */
  | {kind: 'rebindDisplay'; ptyInfo?: SessionPtyInfo}
  | {kind: 'transportClosed'};
type TraceEvent =
  | {type: 'output'; sequence: number; offset: number; characters: number; source: 'session' | 'local'}
  | {type: 'parsed'; sequence: number; outputSequence: number; parsedThrough: number}
  | {type: 'resize'; columns: number; rows: number; outputSequence: number; parsedThrough: number; stateJson?: string; stateCharacters?: number}
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
  private pendingOutputs = new Map<number, {data: string; source: 'session' | 'local'}>();
  constructor(readonly initial: NativeDisplayTraceInitial, private readonly observeParsedOutput = false) {
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
    if (this.observeParsedOutput) this.pendingOutputs.set(sequence, {data: value, source});
    this.characters += value.length;return sequence;
  }
  parsed(sequence: number, output?: {data: string; source: 'session' | 'local'}) {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > this.outputSequence) {this.issue('Unknown parsed output sequence');return;}
    if (this.observeParsedOutput) {
      const pending = this.pendingOutputs.get(sequence);
      if (sequence !== this.parsedThrough + 1 || !pending || !output || output.data !== pending.data || output.source !== pending.source) {
        this.issue('Actual parsed output identity or callback order differs');return;
      }
      this.pendingOutputs.delete(sequence);
      this.append({type: 'parsed', sequence, outputSequence: this.outputSequence, parsedThrough: sequence});
    }
    this.parsedThrough = Math.max(this.parsedThrough, sequence);
  }
  resize(columns: number, rows: number, state?: string) {
    if (!this.observeParsedOutput && this.parsedThrough !== this.outputSequence) this.issue('Resize occurred before previously observed output was parsed');
    if (this.observeParsedOutput) {
      if (state === undefined) this.issue('Actual public resize state is missing');
      else {
        try {const value = JSON.parse(state);if (value.columns !== columns || value.rows !== rows) this.issue('Actual public resize dimensions differ');}
        catch {this.issue('Actual public resize state is invalid');}
      }
    }
    this.append({type: 'resize', columns, rows, outputSequence: this.outputSequence, parsedThrough: this.parsedThrough,
      ...(this.observeParsedOutput && state !== undefined ? {stateJson: state, stateCharacters: state.length} : {})});
  }
  action(action: NativeDisplayTraceAction) {
    if (this.observeParsedOutput && this.parsedThrough !== this.outputSequence) this.issue('Action occurred before actual output parsing completed');
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
    const rebindLifecycle=this.events.some(event=>event.type==='action'&&event.action.kind==='rebindDisplay');
    const renderingLifecycle=this.events.some(event=>event.type==='action'&&(event.action.kind==='transportClosed'||event.action.kind==='unicodeVersion'));
    const publicPaste=this.events.some(event=>event.type==='action'&&event.action.kind==='paste');
    return {version: this.observeParsedOutput?6:publicPaste?5:rebindLifecycle?4:renderingLifecycle?3:2, streamKind: 'actual-visible-output', offsetUnit: 'UTF16-code-units', initial: this.initial, events: this.events,
      outputCharacters: this.characters, outputEvents: this.outputSequence + 1, issues: [...this.issues],
      replayable: this.issues.length === 0, inputOrLifecycleAuthority: false, originalWireBytesClaimed: false};
  }
}

/** Observe the actual public UI operation before it can scroll or emit onData.
 * The display stream still comes exclusively from subscribeDisplayOutput. */
export function pasteWithNativeDisplayTrace(terminal: Terminal, trace: NativeDisplayTrace, data: string): void {
  trace.action({kind:'paste',data});
  terminal.paste(data);
}

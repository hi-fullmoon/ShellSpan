import {
  terminalRegistry,
  type TerminalController,
  type TerminalOutputFilter,
} from '@/components/terminal/registry/terminal-registry';
import { getPlatform, type Platform } from '@/lib/platform';
import {
  redactTerminalSecrets,
  renderTerminalText,
  stripAnsi,
  truncateAiContext,
} from '@/lib/terminal-output-buffer';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AgentTargetSnapshot, AgentToolCall, AgentToolResult } from '@/types/agent';

export const AGENT_TERMINAL_DEFAULT_TIMEOUT_MS = 120_000;
export const AGENT_TERMINAL_INTERRUPT_GRACE_MS = 5_000;
export const AGENT_TERMINAL_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
export const AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const AGENT_TERMINAL_COMMAND_LIMIT_CHARS = 8_192;

const BOUNDARY_PREFIX = 'SHELLSPAN_M2_';
const BOUNDARY_ENTROPY_BYTES = 24;
const COMPLETION_CAPABILITY_HEX_CHARS = BOUNDARY_ENTROPY_BYTES * 2;
const COMPLETION_COMMITMENT_HEX_CHARS = 64;
const COMPLETION_CAPABILITY_FAILURE = '0'.repeat(COMPLETION_CAPABILITY_HEX_CHARS);
const COMPLETION_COMMITMENT_FAILURE = 'f9a2ba511957122bfa67b029061c679703494540b35f02e0e0496a3b0cdcc46a';
const RECORD_SEPARATOR = '\u001e';
const UNIT_SEPARATOR = '\u001f';
const MAX_EXIT_CODE_TOKEN_CHARS = 20;
const DISPLAY_FILTER_FAIL_OPEN_LIMIT_CHARS = 64 * 1024;
const CAPTURE_OMISSION_MARKER = '\n[... terminal output beyond the 2 MiB capture boundary omitted ...]\n';
const TRUSTED_POSIX_READ_ONLY_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const POWERSHELL_COMMAND_ENVIRONMENT = 'SHELLSPAN_AGENT_COMMAND';
const POWERSHELL_MARKER_ENVIRONMENT = 'SHELLSPAN_AGENT_MARKER';
const POWERSHELL_CANCEL_ENVIRONMENT = 'SHELLSPAN_AGENT_CANCEL';
const POWERSHELL_GATE_ENVIRONMENT = 'SHELLSPAN_AGENT_GATE';
const POWERSHELL_PARENT_PID_ENVIRONMENT = 'SHELLSPAN_AGENT_PARENT_PID';
const POWERSHELL_PARENT_START_ENVIRONMENT = 'SHELLSPAN_AGENT_PARENT_START';
const POWERSHELL_USER_MODULE_PATH_ENVIRONMENT = 'SHELLSPAN_AGENT_USER_PSMODULEPATH';
const PTY_WRITE_PROGRESS_FALLBACK_MS = 25;
const POWERSHELL_PTY_STRING_CHUNK_BYTES = 384;
const POWERSHELL_PTY_PHYSICAL_LINE_TARGET_BYTES = 768;
const POWERSHELL_PTY_PHYSICAL_LINE_LIMIT_BYTES = 1_024;

const WINDOWS_RUNTIME_INJECTION_ENVIRONMENT = [
  'APPDOMAIN_MANAGER_ASM',
  'APPDOMAIN_MANAGER_TYPE',
  'COR_ENABLE_PROFILING',
  'COR_PROFILER',
  'COR_PROFILER_PATH',
  'COR_PROFILER_PATH_32',
  'COR_PROFILER_PATH_64',
  'CORECLR_ENABLE_PROFILING',
  'CORECLR_PROFILER',
  'CORECLR_PROFILER_PATH',
  'CORECLR_PROFILER_PATH_32',
  'CORECLR_PROFILER_PATH_64',
  'DEVPATH',
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_SHARED_STORE',
  'DOTNET_STARTUP_HOOKS',
  'PSExecutionPolicyPreference',
  'PSModuleAnalysisCachePath',
] as const;

type AgentTerminalShell = 'posix' | 'powershell';

export type AgentTerminalAuthorizationSource =
  | 'explicitUserAction'
  | 'explicitUpstreamAuthorization';

/**
 * A local, non-wire assertion supplied by the layer that explicitly triggered
 * or approved the structured M1 tool call. M2 validates correlation only; it
 * never classifies risk or manufactures approval on its own.
 */
export interface AgentTerminalExecutionAuthorization {
  readonly decision: 'authorized';
  readonly source: AgentTerminalAuthorizationSource;
  readonly requestId: string;
  readonly callId: string;
  readonly sessionId: string;
}

export interface AuthorizedAgentTerminalExecution {
  readonly toolCall: AgentToolCall;
  readonly authorization: AgentTerminalExecutionAuthorization;
  readonly isolateReadOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AgentTerminalBoundary {
  readonly marker: string;
  readonly beginPrefix: string;
  readonly endPrefix: string;
}

export interface AgentTerminalFrames {
  readonly beginToken: string;
  readonly endPrefix: string;
}

export function createAgentTerminalInputChunks(
  wrapper: string,
  shell: AgentTerminalShell,
): readonly string[] {
  const lines = wrapper.split('\n');
  if (shell === 'powershell') return lines.map((line) => `${line}\r`);
  return lines.map((line, index) => `${line}${index === lines.length - 1 ? '\r' : '\n'}`);
}

interface BoundaryParseResult {
  readonly exitCode: number;
}

interface CapturedText {
  readonly text: string;
  readonly truncated: boolean;
}

interface ActiveExecution {
  readonly requestId: string;
  readonly callId: string;
  readonly cancellation: AbortController;
}

interface ExecutorOptions {
  readonly nonceFactory?: () => string;
  readonly platform?: Platform;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const SHA256_INITIAL_STATE: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Text(value: string): string {
  const bytes = encoder.encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000);
  const bitLengthLow = (bytes.length * 8) >>> 0;
  const lengthOffset = padded.length - 8;
  padded[lengthOffset] = (bitLengthHigh >>> 24) & 0xff;
  padded[lengthOffset + 1] = (bitLengthHigh >>> 16) & 0xff;
  padded[lengthOffset + 2] = (bitLengthHigh >>> 8) & 0xff;
  padded[lengthOffset + 3] = bitLengthHigh & 0xff;
  padded[lengthOffset + 4] = (bitLengthLow >>> 24) & 0xff;
  padded[lengthOffset + 5] = (bitLengthLow >>> 16) & 0xff;
  padded[lengthOffset + 6] = (bitLengthLow >>> 8) & 0xff;
  padded[lengthOffset + 7] = bitLengthLow & 0xff;

  const state = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let blockOffset = 0; blockOffset < padded.length; blockOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const offset = blockOffset + index * 4;
      words[index] = (
        (padded[offset] << 24)
        | (padded[offset + 1] << 16)
        | (padded[offset + 2] << 8)
        | padded[offset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < words.length; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < words.length; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < state.length; index += 1) {
      state[index] = (state[index] + round[index]) >>> 0;
    }
  }
  return state.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function sha256CompletionCapability(value: string): string {
  const normalized = value.toLowerCase();
  if (encoder.encode(normalized).length !== COMPLETION_CAPABILITY_HEX_CHARS) {
    throw new Error('Invalid completion capability length');
  }
  return sha256Text(normalized);
}

function isAuthenticatedCompletion(
  commitment: string | undefined,
  capability: string,
): boolean {
  const normalizedCapability = capability.toLowerCase();
  const normalizedCommitment = commitment?.toLowerCase();
  return normalizedCapability !== COMPLETION_CAPABILITY_FAILURE
    && sha256CompletionCapability(normalizedCapability) === normalizedCommitment;
}

/**
 * Removes a retained END candidate without dropping unrelated tail text. A
 * split capability is protocol-private even when the PTY closes before the
 * candidate can be authenticated.
 */
function sanitizeIncompleteCompletionCandidate(value: string, endPrefix: string): string {
  let visible = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(endPrefix, cursor);
    if (start < 0) {
      const retained = longestSuffixMatchingTokenPrefix(value.slice(cursor), [endPrefix]);
      visible += value.slice(cursor, value.length - retained);
      break;
    }
    visible += value.slice(cursor, start);
    const payloadStart = start + endPrefix.length;
    const terminator = value.indexOf(UNIT_SEPARATOR, payloadStart);
    if (terminator >= 0) {
      cursor = terminator + UNIT_SEPARATOR.length;
      continue;
    }

    const suffix = value.slice(payloadStart);
    let sensitiveLength = 0;
    while (
      sensitiveLength < Math.min(COMPLETION_CAPABILITY_HEX_CHARS, suffix.length)
      && /[a-f0-9]/i.test(suffix[sensitiveLength])
    ) sensitiveLength += 1;
    if (
      sensitiveLength === COMPLETION_CAPABILITY_HEX_CHARS
      && suffix[sensitiveLength] === ':'
    ) {
      sensitiveLength += 1;
      if (suffix[sensitiveLength] === '-') sensitiveLength += 1;
      let exitDigits = 0;
      while (
        exitDigits < MAX_EXIT_CODE_TOKEN_CHARS
        && /\d/.test(suffix[sensitiveLength] ?? '')
      ) {
        sensitiveLength += 1;
        exitDigits += 1;
      }
    }
    visible += suffix.slice(sensitiveLength);
    break;
  }
  return visible;
}

function concatBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function utf8PrefixEnd(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const minimum = Math.max(0, bytes.length - 4);
  let start = bytes.length - 1;
  while (start > minimum && (bytes[start] & 0xc0) === 0x80) start -= 1;
  const width = bytes[start] >= 0xf0 && bytes[start] <= 0xf4
    ? 4
    : bytes[start] >= 0xe0 && bytes[start] <= 0xef
      ? 3
      : bytes[start] >= 0xc2 && bytes[start] <= 0xdf
        ? 2
        : 1;
  return width > bytes.length - start ? start : bytes.length;
}

function utf8TailStart(bytes: Uint8Array): number {
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return start;
}

class BoundedTerminalCapture {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Uint8Array[] = [];
  private readonly tail: Uint8Array[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private bytesRead = 0;

  constructor(private readonly hardLimitBytes = AGENT_TERMINAL_CAPTURE_LIMIT_BYTES) {
    this.headLimit = Math.floor(hardLimitBytes / 2);
    this.tailLimit = hardLimitBytes - this.headLimit;
  }

  push(value: string): void {
    if (!value) return;
    const bytes = encoder.encode(value);
    this.bytesRead += bytes.length;
    const headRemaining = this.headLimit - this.headBytes;
    const headCount = Math.min(headRemaining, bytes.length);
    if (headCount > 0) {
      this.head.push(bytes.slice(0, headCount));
      this.headBytes += headCount;
    }
    this.pushTail(bytes.slice(headCount));
  }

  finish(): CapturedText {
    const truncated = this.bytesRead > this.hardLimitBytes;
    const head = concatBytes(this.head, this.headBytes);
    const tail = concatBytes(this.tail, this.tailBytes);
    if (!truncated) {
      const bytes = new Uint8Array(head.length + tail.length);
      bytes.set(head);
      bytes.set(tail, head.length);
      return { text: decoder.decode(bytes), truncated: false };
    }
    const headText = decoder.decode(head.slice(0, utf8PrefixEnd(head)));
    const tailText = decoder.decode(tail.slice(utf8TailStart(tail)));
    return {
      text: `${headText}${CAPTURE_OMISSION_MARKER}${tailText}`,
      truncated: true,
    };
  }

  snapshot(extra = ''): CapturedText {
    const copy = new BoundedTerminalCapture(this.hardLimitBytes);
    copy.head.push(...this.head.map((chunk) => chunk.slice()));
    copy.tail.push(...this.tail.map((chunk) => chunk.slice()));
    copy.headBytes = this.headBytes;
    copy.tailBytes = this.tailBytes;
    copy.bytesRead = this.bytesRead;
    copy.push(extra);
    return copy.finish();
  }

  private pushTail(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.tailLimit === 0) return;
    if (bytes.length >= this.tailLimit) {
      this.tail.length = 0;
      this.tail.push(bytes.slice(bytes.length - this.tailLimit));
      this.tailBytes = this.tailLimit;
      return;
    }
    this.tail.push(bytes);
    this.tailBytes += bytes.length;
    let excess = this.tailBytes - this.tailLimit;
    while (excess > 0) {
      const first = this.tail[0];
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        excess -= first.length;
      } else {
        this.tail[0] = first.slice(excess);
        this.tailBytes -= excess;
        excess = 0;
      }
    }
    if (this.tail.length > 128) {
      this.tail.splice(0, this.tail.length, concatBytes(this.tail, this.tailBytes));
    }
  }
}

export class AgentTerminalBoundaryParser {
  private state: 'awaitingStart' | 'capturing' | 'completed' = 'awaitingStart';
  private pending = '';
  private readonly capture = new BoundedTerminalCapture();
  private finalized?: CapturedText;
  private completionCommitment?: string;

  constructor(private readonly boundary: AgentTerminalBoundary) {}

  hasStarted(): boolean {
    return this.state !== 'awaitingStart';
  }

  push(chunk: string): BoundaryParseResult | null {
    if (!chunk || this.state === 'completed') return null;
    this.pending += chunk;

    if (this.state === 'awaitingStart') {
      while (this.state === 'awaitingStart') {
        const start = this.pending.indexOf(this.boundary.beginPrefix);
        if (start === -1) {
          this.pending = this.pending.slice(
            -Math.max(0, this.boundary.beginPrefix.length - 1),
          );
          return null;
        }
        const commitmentStart = start + this.boundary.beginPrefix.length;
        const terminator = this.pending.indexOf(UNIT_SEPARATOR, commitmentStart);
        if (terminator === -1) {
          if (this.pending.length - commitmentStart <= COMPLETION_COMMITMENT_HEX_CHARS) {
            this.pending = this.pending.slice(start);
            return null;
          }
          this.pending = this.pending.slice(start + 1);
          continue;
        }
        const commitment = this.pending.slice(commitmentStart, terminator);
        if (!new RegExp(`^[a-f0-9]{${COMPLETION_COMMITMENT_HEX_CHARS}}$`, 'i').test(commitment)) {
          this.pending = this.pending.slice(start + 1);
          continue;
        }
        this.completionCommitment = commitment.toLowerCase();
        this.pending = this.pending.slice(terminator + UNIT_SEPARATOR.length);
        this.state = 'capturing';
      }
    }

    while (this.state === 'capturing') {
      const endPrefix = this.boundary.endPrefix;
      const endStart = this.pending.indexOf(endPrefix);
      if (endStart === -1) {
        const safeLength = Math.max(0, this.pending.length - endPrefix.length + 1);
        this.capture.push(this.pending.slice(0, safeLength));
        this.pending = this.pending.slice(safeLength);
        return null;
      }

      this.capture.push(this.pending.slice(0, endStart));
      this.pending = this.pending.slice(endStart);
      const payloadStart = endPrefix.length;
      const terminator = this.pending.indexOf(UNIT_SEPARATOR, payloadStart);
      if (terminator === -1) {
        // A forged or coincidental end prefix must not turn pending parser
        // state into an unbounded side channel around the 2 MiB capture cap.
        const maximumPayloadLength = COMPLETION_CAPABILITY_HEX_CHARS
          + 1
          + MAX_EXIT_CODE_TOKEN_CHARS;
        if (this.pending.length - payloadStart <= maximumPayloadLength) return null;
        this.capture.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      const payload = this.pending.slice(payloadStart, terminator);
      const match = new RegExp(
        `^([a-f0-9]{${COMPLETION_CAPABILITY_HEX_CHARS}}):(-?\\d+)$`,
        'i',
      ).exec(payload);
      const exitCode = Number(match?.[2]);
      if (
        !match
        || !Number.isSafeInteger(exitCode)
        || !isAuthenticatedCompletion(this.completionCommitment, match[1])
      ) {
        this.capture.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      this.pending = this.pending.slice(terminator + UNIT_SEPARATOR.length);
      this.state = 'completed';
      return { exitCode };
    }
    return null;
  }

  finishCapture(): CapturedText {
    if (this.finalized) return this.finalized;
    if (this.state === 'capturing') {
      const snapshot = this.snapshotCapture();
      this.pending = '';
      this.finalized = snapshot;
      return snapshot;
    }
    this.finalized = this.capture.finish();
    return this.finalized;
  }

  snapshotCapture(): CapturedText {
    if (this.finalized) return this.finalized;
    if (this.state !== 'capturing') return this.capture.snapshot();
    return this.capture.snapshot(sanitizeIncompleteCompletionCandidate(
      this.pending,
      this.boundary.endPrefix,
    ));
  }
}

type AgentTerminalDisplayFilterState =
  | 'seekingStart'
  | 'suppressingWrapper'
  | 'suppressingBeginFrame'
  | 'suppressingBeginNewline'
  | 'capturing'
  | 'completed';

function longestSuffixMatchingTokenPrefix(value: string, tokens: readonly string[]): number {
  const maxLength = Math.min(
    value.length,
    Math.max(0, ...tokens.map((token) => token.length - 1)),
  );
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) return length;
  }
  return 0;
}

/**
 * Removes the private M2 wrapper echo and framed boundary records from the
 * visible terminal stream while leaving the raw PTY stream untouched for the
 * authoritative boundary parser. Incomplete protocol input fails open from
 * finish(), so a shell syntax or transport failure cannot hide diagnostics.
 */
export class AgentTerminalDisplayFilter implements TerminalOutputFilter {
  private state: AgentTerminalDisplayFilterState = 'seekingStart';
  private pending = '';
  private wrapperSuppressionAvailable = true;
  private readonly wrapperEchoPrefix: string;
  private completionCommitment?: string;

  constructor(
    private readonly boundary: AgentTerminalBoundary,
    private readonly command: string,
    shell: AgentTerminalShell,
  ) {
    const nonce = boundary.marker.slice(BOUNDARY_PREFIX.length);
    this.wrapperEchoPrefix = `${shell === 'powershell' ? '$' : ''}__tb_marker_${nonce}=`;
  }

  push(chunk: string): string {
    if (!chunk) return '';
    if (this.state === 'completed') return chunk;
    this.pending += chunk;
    let visible = '';

    while (this.pending) {
      if (this.state === 'seekingStart') {
        const wrapperStart = this.wrapperSuppressionAvailable
          ? this.pending.indexOf(this.wrapperEchoPrefix)
          : -1;
        const beginStart = this.pending.indexOf(this.boundary.beginPrefix);
        if (wrapperStart >= 0 && (beginStart < 0 || wrapperStart <= beginStart)) {
          visible += this.pending.slice(0, wrapperStart);
          this.pending = this.pending.slice(wrapperStart);
          this.wrapperSuppressionAvailable = false;
          this.state = 'suppressingWrapper';
          continue;
        }
        if (beginStart >= 0) {
          visible += this.pending.slice(0, beginStart);
          this.pending = this.pending.slice(beginStart + this.boundary.beginPrefix.length);
          this.state = 'suppressingBeginFrame';
          continue;
        }

        const activeTokens = this.wrapperSuppressionAvailable
          ? [this.wrapperEchoPrefix, this.boundary.beginPrefix]
          : [this.boundary.beginPrefix];
        const retained = longestSuffixMatchingTokenPrefix(this.pending, activeTokens);
        visible += this.pending.slice(0, this.pending.length - retained);
        this.pending = this.pending.slice(this.pending.length - retained);
        break;
      }

      if (this.state === 'suppressingWrapper') {
        const beginStart = this.pending.indexOf(this.boundary.beginPrefix);
        if (beginStart < 0) {
          if (this.pending.length > DISPLAY_FILTER_FAIL_OPEN_LIMIT_CHARS) {
            visible += this.pending;
            this.pending = '';
            this.state = 'seekingStart';
          }
          break;
        }
        this.pending = this.pending.slice(beginStart + this.boundary.beginPrefix.length);
        visible += `${this.command}\r\n`;
        this.state = 'suppressingBeginFrame';
        continue;
      }

      if (this.state === 'suppressingBeginFrame') {
        const terminator = this.pending.indexOf(UNIT_SEPARATOR);
        if (terminator < 0) {
          if (this.pending.length <= COMPLETION_COMMITMENT_HEX_CHARS) break;
          visible += `${this.boundary.beginPrefix}${this.pending}`;
          this.pending = '';
          this.state = 'seekingStart';
          continue;
        }
        const commitment = this.pending.slice(0, terminator);
        if (!new RegExp(`^[a-f0-9]{${COMPLETION_COMMITMENT_HEX_CHARS}}$`, 'i').test(commitment)) {
          visible += this.boundary.beginPrefix;
          this.state = 'seekingStart';
          continue;
        }
        this.completionCommitment = commitment.toLowerCase();
        this.pending = this.pending.slice(terminator + UNIT_SEPARATOR.length);
        this.state = 'suppressingBeginNewline';
        continue;
      }

      if (this.state === 'suppressingBeginNewline') {
        if (this.pending.startsWith('\r') && this.pending.length === 1) break;
        if (this.pending.startsWith('\r\n')) {
          this.pending = this.pending.slice(2);
        } else if (this.pending.startsWith('\n') || this.pending.startsWith('\r')) {
          this.pending = this.pending.slice(1);
        }
        this.state = 'capturing';
        continue;
      }

      if (this.state === 'capturing') {
        const endPrefix = this.boundary.endPrefix;
        const endStart = this.pending.indexOf(endPrefix);
        if (endStart < 0) {
          const retained = longestSuffixMatchingTokenPrefix(this.pending, [endPrefix]);
          visible += this.pending.slice(0, this.pending.length - retained);
          this.pending = this.pending.slice(this.pending.length - retained);
          break;
        }

        visible += this.pending.slice(0, endStart);
        this.pending = this.pending.slice(endStart);
        const payloadStart = endPrefix.length;
        const terminator = this.pending.indexOf(UNIT_SEPARATOR, payloadStart);
        if (terminator < 0) {
          const maximumPayloadLength = COMPLETION_CAPABILITY_HEX_CHARS
            + 1
            + MAX_EXIT_CODE_TOKEN_CHARS;
          if (this.pending.length - payloadStart <= maximumPayloadLength) break;
          visible += this.pending.slice(0, 1);
          this.pending = this.pending.slice(1);
          continue;
        }
        const payload = this.pending.slice(payloadStart, terminator);
        const match = new RegExp(
          `^([a-f0-9]{${COMPLETION_CAPABILITY_HEX_CHARS}}):(-?\\d+)$`,
          'i',
        ).exec(payload);
        const exitCode = Number(match?.[2]);
        if (
          !match
          || !isAuthenticatedCompletion(this.completionCommitment, match[1])
          || !Number.isSafeInteger(exitCode)
        ) {
          visible += this.pending.slice(0, 1);
          this.pending = this.pending.slice(1);
          continue;
        }

        this.pending = this.pending.slice(terminator + UNIT_SEPARATOR.length);
        this.state = 'completed';
        continue;
      }

      visible += this.pending;
      this.pending = '';
    }

    return visible;
  }

  finish(): string {
    const remainder = this.state === 'suppressingBeginFrame'
      ? `${this.boundary.beginPrefix}${this.pending}`
      : this.state === 'capturing'
        ? sanitizeIncompleteCompletionCandidate(this.pending, this.boundary.endPrefix)
        : this.pending;
    this.pending = '';
    this.state = 'completed';
    return remainder;
  }
}

function createSecureNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('secure randomness is unavailable');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(BOUNDARY_ENTROPY_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createAgentTerminalBoundary(nonce = createSecureNonce()): AgentTerminalBoundary {
  if (!/^[a-f0-9]{32,}$/i.test(nonce)) {
    throw new Error('Agent terminal boundary nonce must contain at least 128 bits of entropy');
  }
  const marker = `${BOUNDARY_PREFIX}${nonce.toLowerCase()}`;
  return {
    marker,
    beginPrefix: `${RECORD_SEPARATOR}${marker}:BEGIN:`,
    endPrefix: `${RECORD_SEPARATOR}${marker}:END:`,
  };
}

export function createAgentTerminalFrames(
  boundary: AgentTerminalBoundary,
  completionCapability: string,
): AgentTerminalFrames {
  if (!new RegExp(`^[a-f0-9]{${COMPLETION_CAPABILITY_HEX_CHARS}}$`, 'i').test(completionCapability)) {
    throw new Error('Agent terminal completion capability must contain 192 bits of entropy');
  }
  const capability = completionCapability.toLowerCase();
  return {
    beginToken: `${boundary.beginPrefix}${sha256CompletionCapability(capability)}${UNIT_SEPARATOR}`,
    endPrefix: `${boundary.endPrefix}${capability}:`,
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePosixForPty(value: string): string {
  const characters = [...value];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 32) {
    chunks.push(quotePosix(characters.slice(index, index + 32).join('')));
  }
  return (chunks.length > 0 ? chunks : [quotePosix('')]).join('\\\n');
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePowerShellForPty(value: string): string {
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const character of value) {
    const escapedBytes = encoder.encode(character).length + (character === "'" ? 1 : 0);
    if (chunk && chunkBytes + escapedBytes > POWERSHELL_PTY_STRING_CHUNK_BYTES) {
      chunks.push(quotePowerShell(chunk));
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += escapedBytes;
  }
  if (chunk || chunks.length === 0) chunks.push(quotePowerShell(chunk));
  return chunks.join('+`\n');
}

function wrapPowerShellForPty(script: string): string {
  let wrapped = '';
  let lineBytes = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (character === '\n') {
      wrapped += character;
      lineBytes = 0;
      escaped = false;
      continue;
    }

    if (doubleQuoted && escaped) {
      escaped = false;
    } else if (doubleQuoted && character === '`') {
      escaped = true;
    } else if (!doubleQuoted && character === "'") {
      if (singleQuoted && script[index + 1] === "'") {
        wrapped += "''";
        lineBytes += 2;
        index += 1;
        continue;
      }
      singleQuoted = !singleQuoted;
    } else if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
    }

    if (
      character === ' '
      && !singleQuoted
      && !doubleQuoted
      && lineBytes >= POWERSHELL_PTY_PHYSICAL_LINE_TARGET_BYTES
    ) {
      wrapped += ' `\n';
      lineBytes = 0;
      continue;
    }
    wrapped += character;
    lineBytes += encoder.encode(character).length;
  }

  const maximumLineBytes = Math.max(
    ...wrapped.split('\n').map((line) => encoder.encode(line).length),
  );
  if (maximumLineBytes > POWERSHELL_PTY_PHYSICAL_LINE_LIMIT_BYTES) {
    throw new Error(`PowerShell agent wrapper contains a ${maximumLineBytes}-byte PTY input line`);
  }
  return wrapped;
}

function encodePowerShellCommand(value: string): string {
  let utf16LittleEndian = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    utf16LittleEndian += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
  }
  return globalThis.btoa(utf16LittleEndian);
}

function buildPosixWrapper(
  command: string,
  boundary: AgentTerminalBoundary,
  isolateReadOnly: boolean,
): string {
  const nonce = boundary.marker.slice(BOUNDARY_PREFIX.length);
  const split = Math.floor(boundary.marker.length / 2);
  const markerFirst = boundary.marker.slice(0, split);
  const markerSecond = boundary.marker.slice(split);
  const outerMarkerVar = `__tb_marker_${nonce}`;
  // The trusted supervisor owns the completion capability. The command runs
  // in a separate process group with protocol variables removed from its
  // environment, while BEGIN exposes only a SHA-256 commitment.
  const supervisorVariables = [
    '__tb_m', '__tb_c', '__tb_k', '__tb_h', '__tb_b', '__tb_f', '__tb_p', '__tb_s',
    '__tb_ck', '__tb_ch', '__tb_x', '__tb_q', '__tb_i', '__tb_e', '__tb_r',
  ];
  const finishFunction = [
    '__tb_s=$1',
    'trap - INT TERM HUP QUIT TSTP',
    `if /bin/test "$__tb_k" = ${quotePosix(COMPLETION_CAPABILITY_FAILURE)}; then /usr/bin/printf '%s\\n' 'Secure completion capability generation failed.'; exit 125; fi`,
    '__tb_q=0',
    'if /bin/test -n "$__tb_p"; then /bin/kill -TERM "-$__tb_p" 2>/dev/null; /bin/kill -KILL "-$__tb_p" 2>/dev/null; wait "$__tb_p" 2>/dev/null; __tb_i=0; __tb_group_state; __tb_r=$?; while /bin/test "$__tb_r" -eq 0; do if /bin/test "$__tb_i" -ge 20; then __tb_q=1; break; fi; /bin/kill -KILL "-$__tb_p" 2>/dev/null; /bin/sleep 0.05; __tb_i=$((__tb_i + 1)); __tb_group_state; __tb_r=$?; done; if /bin/test "$__tb_r" -eq 2; then __tb_q=1; fi; __tb_p=; fi',
    'if /bin/test "$__tb_q" -ne 0; then /usr/bin/printf \'%s\\n\' \'Agent command process group termination could not be confirmed. Terminal remains quarantined.\'; exit "$__tb_s"; fi',
    'if /bin/test "$__tb_b" -eq 0; then /usr/bin/printf \'\\036%s:BEGIN:%s\\037\\n\' "$__tb_m" "$__tb_h"; __tb_b=1; fi',
    '/usr/bin/printf \'\\036%s:END:%s:%d\\037\' "$__tb_m" "$__tb_k" "$__tb_s"',
    'exit "$__tb_s"',
  ].join('; ');
  const commandInvocation = isolateReadOnly
    ? `/usr/bin/env -i PATH=${TRUSTED_POSIX_READ_ONLY_PATH} LC_ALL=C PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat /bin/sh -c "$__tb_c" </dev/null`
    : '/bin/sh -c "$__tb_c" </dev/null';
  const supervisorScript = [
    // The invoking shell may export xtrace/verbose through SHELLOPTS. Disable
    // both before assigning any protocol secret, even though env also removes
    // the startup controls before this supervisor is parsed.
    'set +a +e +u +m +x +v',
    '__tb_m=$1',
    '__tb_c=$2',
    `__tb_k=${quotePosix(COMPLETION_CAPABILITY_FAILURE)}`,
    `__tb_h=${quotePosix(COMPLETION_COMMITMENT_FAILURE)}`,
    '__tb_b=0',
    '__tb_f=0',
    '__tb_p=',
    '__tb_group_state() { __tb_e=$(LC_ALL=C /bin/kill -0 "-$__tb_p" 2>&1); __tb_r=$?; if /bin/test "$__tb_r" -eq 0; then return 0; fi; case "$__tb_e" in *"No such process"*) return 1 ;; *) return 2 ;; esac; }',
    `__tb_finish() { ${finishFunction}; }`,
    "trap '__tb_finish 130' INT TERM HUP QUIT TSTP",
    `__tb_ck=$(/usr/bin/env -i LC_ALL=C /usr/bin/od -An -N${BOUNDARY_ENTROPY_BYTES} -tx1 /dev/urandom 2>/dev/null | /usr/bin/env -i LC_ALL=C /usr/bin/tr -d '[:space:]')`,
    `if ! /bin/test "\${#__tb_ck}" -eq ${COMPLETION_CAPABILITY_HEX_CHARS} || /bin/test "$__tb_ck" = ${quotePosix(COMPLETION_CAPABILITY_FAILURE)}; then __tb_f=1; elif /bin/test -x /usr/bin/shasum; then __tb_ch=$(/usr/bin/printf '%s' "$__tb_ck" | /usr/bin/env -i LC_ALL=C /usr/bin/shasum -a 256); elif /bin/test -x /usr/bin/sha256sum; then __tb_ch=$(/usr/bin/printf '%s' "$__tb_ck" | /usr/bin/env -i LC_ALL=C /usr/bin/sha256sum); elif /bin/test -x /bin/sha256sum; then __tb_ch=$(/usr/bin/printf '%s' "$__tb_ck" | /usr/bin/env -i LC_ALL=C /bin/sha256sum); else __tb_f=1; fi`,
    '__tb_ch=${__tb_ch%% *}',
    `if ! /bin/test "\${#__tb_ch}" -eq ${COMPLETION_COMMITMENT_HEX_CHARS}; then __tb_f=1; fi`,
    'if /bin/test "$__tb_f" -eq 0; then __tb_k=$__tb_ck __tb_h=$__tb_ch; fi',
    "/usr/bin/printf '\\036%s:BEGIN:%s\\037\\n' \"$__tb_m\" \"$__tb_h\"",
    '__tb_b=1',
    'if /bin/test "$__tb_f" -ne 0; then __tb_finish 125; fi',
    'PAGER=cat; GIT_PAGER=cat; SYSTEMD_PAGER=cat; export PAGER GIT_PAGER SYSTEMD_PAGER',
    'set -m',
    `${commandInvocation} & __tb_p=$!`,
    'set +m',
    'if wait "$__tb_p"; then __tb_x=0; else __tb_x=$?; fi',
    // Keep the process-group id live until finish() has terminated any
    // descendants which survived the root command shell.
    '__tb_finish "$__tb_x"',
  ].join('; ');
  const dynamicLoaderEnvironment = [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'LD_DEBUG',
    'LD_DEBUG_OUTPUT',
    'LD_TRACE_LOADED_OBJECTS',
    'GLIBC_TUNABLES',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
  ];
  const physicalLineContinuation = ' \\\n';
  const clearedEnvironment = [
    outerMarkerVar,
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'BASHOPTS',
    'PS4',
    'PROMPT_COMMAND',
    ...dynamicLoaderEnvironment,
    ...supervisorVariables,
  ]
    .map((name) => `-u ${name}`)
    .join(physicalLineContinuation);
  return [
    `${outerMarkerVar}=${quotePosix(markerFirst)}${quotePosix(markerSecond)}; if (`,
    `unset ${dynamicLoaderEnvironment.join(' ')}; exec /usr/bin/env ${clearedEnvironment}`,
    `/bin/sh -c ${quotePosixForPty(supervisorScript)}`,
    `shellspan ${quotePosix(boundary.marker)}`,
    quotePosixForPty(command),
    `); then :; else :; fi; unset ${outerMarkerVar}`,
  ].join(physicalLineContinuation);
}

function buildPowerShellWrapper(
  command: string,
  boundary: AgentTerminalBoundary,
  isolateReadOnly: boolean,
): string {
  const nonce = boundary.marker.slice(BOUNDARY_PREFIX.length);
  const split = Math.floor(boundary.marker.length / 2);
  const markerFirst = boundary.marker.slice(0, split);
  const markerSecond = boundary.marker.slice(split);
  const variable = (name: string): string => `$__tb_${name}_${nonce}`;
  const markerVar = variable('marker');
  const commandVar = variable('command');
  const cancelPathVar = variable('cancel_path');
  const cancelPartPathVar = variable('cancel_part_path');
  const supervisorScriptVar = variable('supervisor_script');
  const commandModulePathVar = variable('command_module_path');
  const injectionKeysVar = variable('injection_keys');
  const injectionKeyVar = variable('injection_key');
  const processInfoVar = variable('process_info');
  const processVar = variable('process');
  const processStartedVar = variable('process_started');
  const cleanupDeadlineVar = variable('cleanup_deadline');
  const taskkillInfoVar = variable('taskkill_info');
  const taskkillProcessVar = variable('taskkill_process');
  const exitVar = variable('exit');
  const systemDirectoryExpression =
    '[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::System)';
  const systemRootExpression =
    `[System.IO.Directory]::GetParent(${systemDirectoryExpression}).FullName`;
  const powershellExecutableExpression =
    `[System.IO.Path]::Combine(${systemDirectoryExpression},'WindowsPowerShell','v1.0','powershell.exe')`;

  const commandBootstrap = [
    '$global:LASTEXITCODE=$null',
    `$__shellspanCommand=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_COMMAND_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanGateName=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_GATE_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_COMMAND_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_GATE_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    '$__shellspanGate=[System.Threading.EventWaitHandle]::OpenExisting($__shellspanGateName)',
    'try { [void]$__shellspanGate.WaitOne() } finally { $__shellspanGate.Dispose() }',
    '$__shellspanChildScript=[ScriptBlock]::Create($__shellspanCommand)',
    '& $__shellspanChildScript',
    '$__shellspanChildOk=$?',
    '$__shellspanChildNative=$global:LASTEXITCODE',
    'if ($__shellspanChildOk) { exit 0 } elseif ($null -ne $__shellspanChildNative) { exit ([int]$__shellspanChildNative) } else { exit 1 }',
  ].join(';');
  const commandArguments = `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(commandBootstrap)}`;

  const jobObjectSource = [
    'using System;using System.Runtime.InteropServices;',
    'public static class ShellSpanAgentJob{',
    '[StructLayout(LayoutKind.Sequential)]public struct BasicLimit{public long a,b;public uint LimitFlags;public UIntPtr c,d;public uint e;public UIntPtr f;public uint g,h;}',
    '[StructLayout(LayoutKind.Sequential)]public struct IoCounters{public ulong a,b,c,d,e,f;}',
    '[StructLayout(LayoutKind.Sequential)]public struct ExtendedLimit{public BasicLimit BasicLimitInformation;public IoCounters a;public UIntPtr b,c,d,e;}',
    '[StructLayout(LayoutKind.Sequential)]public struct BasicAccounting{public long a,b,c,d;public uint e,f;public uint ActiveProcesses;public uint g;}',
    "[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr CreateJobObject(IntPtr a,string n);",
    "[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool SetInformationJobObject(IntPtr j,int c,ref ExtendedLimit i,uint l);",
    "[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);",
    "[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool TerminateJobObject(IntPtr j,uint e);",
    "[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool QueryInformationJobObject(IntPtr j,int c,out BasicAccounting i,uint l,IntPtr r);",
    "[DllImport(\"kernel32.dll\",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]public static extern bool CloseHandle(IntPtr h);",
    'public static bool EnableKillOnClose(IntPtr j){var i=new ExtendedLimit();i.BasicLimitInformation.LimitFlags=0x2000;return SetInformationJobObject(j,9,ref i,(uint)Marshal.SizeOf(typeof(ExtendedLimit)));}',
    'public static int GetActiveProcessCount(IntPtr j){BasicAccounting i;return QueryInformationJobObject(j,1,out i,(uint)Marshal.SizeOf(typeof(BasicAccounting)),IntPtr.Zero)?(int)i.ActiveProcesses:-1;}',
    '}',
  ].join('');

  const privateSupervisor = [
    "$ErrorActionPreference='Stop'",
    `$__shellspanMarker=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_MARKER_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanCommand=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_COMMAND_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanCancelPath=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_CANCEL_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanParentIdText=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_PARENT_PID_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanParentStartText=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_PARENT_START_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `$__shellspanUserModulePath=[System.Environment]::GetEnvironmentVariable('${POWERSHELL_USER_MODULE_PATH_ENVIRONMENT}',[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_MARKER_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_COMMAND_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_CANCEL_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_PARENT_PID_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_PARENT_START_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    `[System.Environment]::SetEnvironmentVariable('${POWERSHELL_USER_MODULE_PATH_ENVIRONMENT}',$null,[System.EnvironmentVariableTarget]::Process)`,
    "[System.Environment]::SetEnvironmentVariable('PAGER','cat',[System.EnvironmentVariableTarget]::Process)",
    "[System.Environment]::SetEnvironmentVariable('GIT_PAGER','cat',[System.EnvironmentVariableTarget]::Process)",
    "[System.Environment]::SetEnvironmentVariable('SYSTEMD_PAGER','cat',[System.EnvironmentVariableTarget]::Process)",
    '$__shellspanParentId=[int]0',
    '$__shellspanParentStart=[long]0',
    '$__shellspanParent=$null',
    '$__shellspanParentReady=[int]::TryParse($__shellspanParentIdText,[ref]$__shellspanParentId) -and [long]::TryParse($__shellspanParentStartText,[ref]$__shellspanParentStart)',
    'if ($__shellspanParentReady) { try { $__shellspanParent=[System.Diagnostics.Process]::GetProcessById($__shellspanParentId); [void]$__shellspanParent.Handle; $__shellspanParentReady=(-not $__shellspanParent.HasExited -and $__shellspanParent.StartTime.Ticks -eq $__shellspanParentStart) } catch { $__shellspanParentReady=$false } }',
    'function Test-ShellSpanParent { if (-not $__shellspanParentReady -or $null -eq $__shellspanParent) { return $false }; try { return (-not $__shellspanParent.WaitForExit(0)) } catch { return $false } }',
    `$__shellspanCapability='${COMPLETION_CAPABILITY_FAILURE}'`,
    `$__shellspanCommitment='${COMPLETION_COMMITMENT_FAILURE}'`,
    '$__shellspanCapabilityFailed=$false',
    '$__shellspanRandom=$null',
    '$__shellspanHash=$null',
    `try { $__shellspanBytes=[byte[]][System.Array]::CreateInstance([byte],${BOUNDARY_ENTROPY_BYTES}); $__shellspanRandom=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $__shellspanRandom.GetBytes($__shellspanBytes); $__shellspanCapability=[System.BitConverter]::ToString($__shellspanBytes).Replace('-','').ToLowerInvariant(); if ($__shellspanCapability -eq '${COMPLETION_CAPABILITY_FAILURE}') { throw [System.Security.Cryptography.CryptographicException]::new('Invalid random capability.') }; $__shellspanHash=[System.Security.Cryptography.SHA256]::Create(); $__shellspanCommitment=[System.BitConverter]::ToString($__shellspanHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($__shellspanCapability))).Replace('-','').ToLowerInvariant() } catch { $__shellspanCapabilityFailed=$true; $__shellspanCapability='${COMPLETION_CAPABILITY_FAILURE}'; $__shellspanCommitment='${COMPLETION_COMMITMENT_FAILURE}' } finally { if ($null -ne $__shellspanRandom) { $__shellspanRandom.Dispose() }; if ($null -ne $__shellspanHash) { $__shellspanHash.Dispose() } }`,
    `if ($__shellspanCapabilityFailed) { [Console]::WriteLine('Secure completion capability generation failed.'); exit 125 }`,
    "[Console]::WriteLine((-join ([char]30,$__shellspanMarker,':BEGIN:',$__shellspanCommitment,[char]31)))",
    '$__shellspanJob=[IntPtr]::Zero',
    '$__shellspanGate=$null',
    '$__shellspanProcess=$null',
    '$__shellspanStarted=$false',
    '$__shellspanAssigned=$false',
    '$__shellspanCleanupConfirmed=$true',
    '$__shellspanExit=126',
    'try {',
    `if (-not (Test-ShellSpanParent) -or [System.IO.File]::Exists($__shellspanCancelPath)) { $__shellspanExit=130 } else { Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition ${quotePowerShell(jobObjectSource)}; if (-not (Test-ShellSpanParent)) { $__shellspanExit=130 } else { $__shellspanJob=[ShellSpanAgentJob]::CreateJobObject([IntPtr]::Zero,$null); if ($__shellspanJob -eq [IntPtr]::Zero -or -not [ShellSpanAgentJob]::EnableKillOnClose($__shellspanJob)) { throw [System.InvalidOperationException]::new('Unable to create a contained command job.') }; $__shellspanGateName='shellspan-gate-'+[System.Guid]::NewGuid().ToString('N'); $__shellspanGate=[System.Threading.EventWaitHandle]::new($false,[System.Threading.EventResetMode]::ManualReset,$__shellspanGateName); $__shellspanInfo=[System.Diagnostics.ProcessStartInfo]::new(); $__shellspanInfo.FileName=${powershellExecutableExpression}; $__shellspanInfo.Arguments=${quotePowerShell(commandArguments)}; $__shellspanInfo.UseShellExecute=$false; $__shellspanInfo.CreateNoWindow=$true; $__shellspanInfo.RedirectStandardInput=$true; if ($null -eq $__shellspanUserModulePath) { [void]$__shellspanInfo.EnvironmentVariables.Remove('PSModulePath') } else { $__shellspanInfo.EnvironmentVariables['PSModulePath']=$__shellspanUserModulePath }; $__shellspanInfo.EnvironmentVariables['${POWERSHELL_COMMAND_ENVIRONMENT}']=$__shellspanCommand; $__shellspanInfo.EnvironmentVariables['${POWERSHELL_GATE_ENVIRONMENT}']=$__shellspanGateName; $__shellspanProcess=[System.Diagnostics.Process]::new(); $__shellspanProcess.StartInfo=$__shellspanInfo; if (-not (Test-ShellSpanParent)) { $__shellspanExit=130 } else { $__shellspanStarted=$__shellspanProcess.Start(); if (-not $__shellspanStarted) { throw [System.InvalidOperationException]::new('Agent command process failed to start.') }; $__shellspanProcess.StandardInput.Close(); $__shellspanAssigned=[ShellSpanAgentJob]::AssignProcessToJobObject($__shellspanJob,$__shellspanProcess.Handle); if (-not $__shellspanAssigned) { throw [System.InvalidOperationException]::new('Agent command process could not enter its containment job.') }; if (-not (Test-ShellSpanParent)) { $__shellspanExit=130 } else { [void]$__shellspanGate.Set(); $__shellspanGate.Dispose(); $__shellspanGate=$null; while (-not $__shellspanProcess.WaitForExit(100)) { if ([System.IO.File]::Exists($__shellspanCancelPath) -or -not (Test-ShellSpanParent)) { $__shellspanExit=130; break } }; if ($__shellspanProcess.HasExited) { $__shellspanExit=$__shellspanProcess.ExitCode } } } } } }`,
    `} catch { if ([System.IO.File]::Exists($__shellspanCancelPath) -or -not (Test-ShellSpanParent)) { $__shellspanExit=130 } else { $__shellspanExit=126 } } finally { if ($__shellspanAssigned -and $__shellspanJob -ne [IntPtr]::Zero) { $__shellspanCleanupConfirmed=$false; if ([ShellSpanAgentJob]::TerminateJobObject($__shellspanJob,1)) { $__shellspanJobCleanupDeadline=[System.DateTime]::UtcNow.AddSeconds(2); do { if ([ShellSpanAgentJob]::GetActiveProcessCount($__shellspanJob) -eq 0) { $__shellspanCleanupConfirmed=$true; break }; [System.Threading.Thread]::Sleep(20) } while ([System.DateTime]::UtcNow -lt $__shellspanJobCleanupDeadline) } } elseif ($__shellspanStarted -and $null -ne $__shellspanProcess) { try { if (-not $__shellspanProcess.HasExited) { $__shellspanProcess.Kill() }; $__shellspanCleanupConfirmed=$__shellspanProcess.WaitForExit(2000) } catch { $__shellspanCleanupConfirmed=$false } }; if ($null -ne $__shellspanGate) { $__shellspanGate.Dispose() }; if ($null -ne $__shellspanProcess) { $__shellspanProcess.Dispose() }; if ($__shellspanJob -ne [IntPtr]::Zero) { [void][ShellSpanAgentJob]::CloseHandle($__shellspanJob) }; if ($null -ne $__shellspanParent) { $__shellspanParent.Dispose() }; try { [System.IO.File]::Delete($__shellspanCancelPath) } catch { } }`,
    `if ($__shellspanCleanupConfirmed) { [Console]::Write((-join ([char]30,$__shellspanMarker,':END:',$__shellspanCapability,':',$__shellspanExit,[char]31))) } else { [Console]::WriteLine('Agent command process tree termination could not be confirmed; terminal remains quarantined.') }`,
    'exit $__shellspanExit',
  ].join(';');
  const privateSupervisorHash = sha256Text(privateSupervisor);
  const supervisorBootstrap = [
    '$__shellspanSupervisor=[Console]::In.ReadToEnd()',
    '$__shellspanHash=[System.Security.Cryptography.SHA256]::Create()',
    `try { $__shellspanActual=[System.BitConverter]::ToString($__shellspanHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($__shellspanSupervisor))).Replace('-','').ToLowerInvariant() } finally { $__shellspanHash.Dispose() }`,
    `if ($__shellspanActual -ne '${privateSupervisorHash}') { exit 125 }`,
    '& ([ScriptBlock]::Create($__shellspanSupervisor))',
  ].join(';');
  const supervisorArguments = `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(supervisorBootstrap)}`;

  const isolatedEnvironment = [
    `${processInfoVar}.EnvironmentVariables.Clear()`,
    `${processInfoVar}.EnvironmentVariables['SystemRoot']=${systemRootExpression}`,
    `${processInfoVar}.EnvironmentVariables['WINDIR']=${systemRootExpression}`,
    `${processInfoVar}.EnvironmentVariables['ComSpec']=[System.IO.Path]::Combine(${systemDirectoryExpression},'cmd.exe')`,
    `${processInfoVar}.EnvironmentVariables['PATH']=${systemDirectoryExpression}`,
    `${processInfoVar}.EnvironmentVariables['PATHEXT']='.COM;.EXE;.BAT;.CMD'`,
    `${processInfoVar}.EnvironmentVariables['PSModulePath']=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName(${processInfoVar}.FileName),'Modules')`,
    `${processInfoVar}.EnvironmentVariables['TEMP']=[System.IO.Path]::GetDirectoryName(${cancelPathVar})`,
    `${processInfoVar}.EnvironmentVariables['TMP']=[System.IO.Path]::GetDirectoryName(${cancelPathVar})`,
  ].join('; ');
  const exactInjectionEnvironment = WINDOWS_RUNTIME_INJECTION_ENVIRONMENT
    .map(quotePowerShell)
    .join(',');
  const scrubbedRuntimeEnvironment = [
    `${injectionKeysVar}=@(${processInfoVar}.EnvironmentVariables.Keys)`,
    `foreach (${injectionKeyVar} in ${injectionKeysVar}) { if (${injectionKeyVar} -match '^(?:COMPLUS_|COR_|CORECLR_)' -or @(${exactInjectionEnvironment}) -contains ${injectionKeyVar}) { [void]${processInfoVar}.EnvironmentVariables.Remove(${injectionKeyVar}) } }`,
  ].join('; ');
  const supervisorVariables = [
    markerVar,
    commandVar,
    cancelPathVar,
    cancelPartPathVar,
    supervisorScriptVar,
    commandModulePathVar,
    injectionKeysVar,
    injectionKeyVar,
    processInfoVar,
    processVar,
    processStartedVar,
    cleanupDeadlineVar,
    taskkillInfoVar,
    taskkillProcessVar,
    exitVar,
  ];

  return wrapPowerShellForPty([
    `${markerVar}=${quotePowerShell(markerFirst)}+${quotePowerShell(markerSecond)}`,
    `${commandVar}=${quotePowerShellForPty(command)}`,
    `${supervisorScriptVar}=${quotePowerShellForPty(privateSupervisor)}`,
    `${commandModulePathVar}=$null`,
    `${cancelPathVar}=[System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),('shellspan-cancel-'+[System.Guid]::NewGuid().ToString('N')+'.flag'))`,
    `${cancelPartPathVar}=${cancelPathVar}+'.part'`,
    `${processInfoVar}=[System.Diagnostics.ProcessStartInfo]::new()`,
    `${processInfoVar}.FileName=${powershellExecutableExpression}`,
    `${processInfoVar}.Arguments=${quotePowerShellForPty(supervisorArguments)}`,
    `${processInfoVar}.UseShellExecute=$false`,
    `${processInfoVar}.CreateNoWindow=$true`,
    `${processInfoVar}.RedirectStandardInput=$true`,
    ...(!isolateReadOnly ? [`${commandModulePathVar}=${processInfoVar}.EnvironmentVariables['PSModulePath']`] : []),
    ...(isolateReadOnly ? [isolatedEnvironment] : []),
    scrubbedRuntimeEnvironment,
    ...(isolateReadOnly
      ? [`${commandModulePathVar}=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName(${processInfoVar}.FileName),'Modules')`]
      : []),
    `${processInfoVar}.EnvironmentVariables['PSModulePath']=[System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName(${processInfoVar}.FileName),'Modules')`,
    `if ($null -ne ${commandModulePathVar}) { ${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_USER_MODULE_PATH_ENVIRONMENT)}]=${commandModulePathVar} } else { [void]${processInfoVar}.EnvironmentVariables.Remove(${quotePowerShell(POWERSHELL_USER_MODULE_PATH_ENVIRONMENT)}) }`,
    `${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_MARKER_ENVIRONMENT)}]=${markerVar}`,
    `${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_COMMAND_ENVIRONMENT)}]=${commandVar}`,
    `${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_CANCEL_ENVIRONMENT)}]=${cancelPathVar}`,
    `${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_PARENT_PID_ENVIRONMENT)}]=[string]$PID`,
    `${processInfoVar}.EnvironmentVariables[${quotePowerShell(POWERSHELL_PARENT_START_ENVIRONMENT)}]=[string][System.Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks`,
    `${processVar}=[System.Diagnostics.Process]::new()`,
    `${processVar}.StartInfo=${processInfoVar}`,
    `${processStartedVar}=$false`,
    `${taskkillInfoVar}=$null`,
    `${taskkillProcessVar}=$null`,
    `${exitVar}=130`,
    `try { ${processStartedVar}=${processVar}.Start(); if (-not ${processStartedVar}) { throw [System.InvalidOperationException]::new('Agent command supervisor failed to start.') }; ${processVar}.StandardInput.Write(${supervisorScriptVar}); ${processVar}.StandardInput.Close(); while (-not ${processVar}.WaitForExit(100)) { }; ${exitVar}=${processVar}.ExitCode } finally { if (${processStartedVar} -and -not ${processVar}.HasExited) { try { [System.IO.File]::WriteAllText(${cancelPartPathVar},'cancel',[System.Text.Encoding]::ASCII); [System.IO.File]::Move(${cancelPartPathVar},${cancelPathVar}) } catch { }; ${cleanupDeadlineVar}=[System.DateTime]::UtcNow.AddSeconds(5); while (-not ${processVar}.WaitForExit(100) -and [System.DateTime]::UtcNow -lt ${cleanupDeadlineVar}) { }; if (-not ${processVar}.HasExited) { try { ${taskkillInfoVar}=[System.Diagnostics.ProcessStartInfo]::new(); ${taskkillInfoVar}.FileName=[System.IO.Path]::Combine(${systemDirectoryExpression},'taskkill.exe'); ${taskkillInfoVar}.Arguments=('/PID '+${processVar}.Id+' /T /F'); ${taskkillInfoVar}.UseShellExecute=$false; ${taskkillInfoVar}.CreateNoWindow=$true; ${taskkillProcessVar}=[System.Diagnostics.Process]::new(); ${taskkillProcessVar}.StartInfo=${taskkillInfoVar}; [void]${taskkillProcessVar}.Start(); [void]${taskkillProcessVar}.WaitForExit(5000) } catch { try { ${processVar}.Kill(); [void]${processVar}.WaitForExit(2000) } catch { } } } }; if (${processVar}.HasExited) { ${exitVar}=${processVar}.ExitCode }; if ($null -ne ${taskkillProcessVar}) { ${taskkillProcessVar}.Dispose() }; ${processVar}.Dispose(); try { [System.IO.File]::Delete(${cancelPathVar}) } catch { }; try { [System.IO.File]::Delete(${cancelPartPathVar}) } catch { }; $global:LASTEXITCODE=${exitVar}; Microsoft.PowerShell.Utility\\Remove-Variable ${supervisorVariables.map((name) => name.slice(1)).join(', ')} -ErrorAction SilentlyContinue }`,
  ].join('; '));
}

export function buildAgentTerminalWrapper(
  command: string,
  boundary: AgentTerminalBoundary,
  shell: AgentTerminalShell,
  isolateReadOnly = false,
): string {
  return shell === 'powershell'
    ? buildPowerShellWrapper(command, boundary, isolateReadOnly)
    : buildPosixWrapper(command, boundary, isolateReadOnly);
}

interface ShellToken {
  readonly kind: 'word' | 'operator';
  readonly value: string;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  const flush = (): void => {
    if (word) tokens.push({ kind: 'word', value: word });
    word = '';
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else word += character;
      continue;
    }
    if (character === '\\') {
      escaped = true;
    } else if (character === "'") {
      quote = 'single';
    } else if (character === '"') {
      quote = 'double';
    } else if (/\s/.test(character)) {
      flush();
    } else if (';|&()`'.includes(character)) {
      flush();
      tokens.push({ kind: 'operator', value: character });
    } else {
      word += character;
    }
  }
  flush();
  return tokens;
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokenizeShell(command)) {
    if (token.kind === 'operator') {
      if (segments[segments.length - 1].length > 0) segments.push([]);
    } else {
      segments[segments.length - 1].push(token.value);
    }
  }
  return segments.filter((segment) => segment.length > 0);
}

const WRAPPER_OPTIONS_WITH_VALUES = new Set([
  '-C', '-D', '-g', '-h', '-p', '-R', '-T', '-t', '-u', '-U', '--chdir', '--group', '--host',
  '--prompt', '--role', '--type', '--user',
]);

function basename(value: string): string {
  return value.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
}

interface ResolvedExecutable {
  readonly program: string;
  readonly args: string[];
  readonly interactivePrivilegeWrapper?: string;
  readonly wrapperReason?: string;
}

function resolveExecutable(words: readonly string[]): ResolvedExecutable | null {
  let index = 0;
  let interactivePrivilegeWrapper: string | undefined;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index])) index += 1;
  while (index < words.length) {
    const wrapper = basename(words[index]);
    if (wrapper === 'command' || wrapper === 'builtin' || wrapper === 'nohup') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index += 1;
      while (index < words.length) {
        const option = words[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (
          option === '-S'
          || option === '--split-string'
          || /^-S.+/.test(option)
          || option.startsWith('--split-string=')
        ) {
          return {
            program: 'env',
            args: words.slice(index),
            wrapperReason: 'opaque env split-string execution is blocked',
          };
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(option)) {
          index += 1;
          continue;
        }
        if (
          option === '-u'
          || option === '--unset'
          || option === '-C'
          || option === '--chdir'
          || option === '-P'
          || option === '-a'
          || option === '--argv0'
        ) {
          index += 2;
          continue;
        }
        if (
          /^-u.+/.test(option)
          || option.startsWith('--unset=')
          || option.startsWith('--chdir=')
          || option.startsWith('--argv0=')
        ) {
          index += 1;
          continue;
        }
        if (['-i', '--ignore-environment', '-0', '--null', '--debug'].includes(option)) {
          index += 1;
          continue;
        }
        if (option.startsWith('-')) {
          return {
            program: 'env',
            args: words.slice(index),
            wrapperReason: `unsupported env wrapper option is blocked: ${option}`,
          };
        }
        break;
      }
      continue;
    }
    if (wrapper === 'sudo' || wrapper === 'doas') {
      return {
        program: wrapper,
        args: words.slice(index + 1),
        wrapperReason: `privilege-changing wrapper cannot guarantee bounded process-tree cleanup: ${wrapper}`,
      };
    }
    if (wrapper === 'nice') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const option = words[index];
        if (option === '-n' || option === '--adjustment') {
          index += 2;
          continue;
        }
        if (/^-n.+/.test(option) || /^-\d+$/.test(option) || option.startsWith('--adjustment=')) {
          index += 1;
          continue;
        }
        return {
          program: wrapper,
          args: words.slice(index),
          wrapperReason: `unsupported nice wrapper option is blocked: ${option}`,
        };
      }
      continue;
    }
    if (wrapper === 'timeout' || wrapper === 'gtimeout') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const option = words[index];
        if (option === '-s' || option === '--signal' || option === '-k' || option === '--kill-after') {
          index += 2;
          continue;
        }
        if (
          /^-[sk].+/.test(option)
          || option.startsWith('--signal=')
          || option.startsWith('--kill-after=')
          || ['--foreground', '--preserve-status', '--verbose'].includes(option)
        ) {
          index += 1;
          continue;
        }
        return {
          program: wrapper,
          args: words.slice(index),
          wrapperReason: `unsupported timeout wrapper option is blocked: ${option}`,
        };
      }
      // Skip timeout's duration and continue resolving the actual command.
      index += 1;
      continue;
    }
    if (/[`$]/.test(words[index]) || /%[^%]+%/.test(words[index])) {
      return {
        program: basename(words[index]),
        args: words.slice(index + 1),
        wrapperReason: 'indirect executable-name expansion is blocked',
      };
    }
    return {
      program: basename(words[index]),
      args: words.slice(index + 1),
      ...(interactivePrivilegeWrapper ? { interactivePrivilegeWrapper } : {}),
    };
  }
  return null;
}

const BLOCKED_PROGRAMS = new Set([
  'vi', 'vim', 'view', 'nvim', 'nano', 'emacs', 'pico', 'joe',
  'less', 'more', 'most', 'man', 'info',
  'ssh', 'sftp', 'scp', 'mosh', 'telnet', 'ftp',
  'top', 'htop', 'btop', 'watch', 'yes', 'fzf', 'lazygit', 'ranger', 'mc',
  'tmux', 'screen', 'lynx', 'w3m',
  'read', 'read-host', 'pause', 'select', 'irb',
  'mysql', 'mariadb', 'psql', 'sqlite3', 'redis-cli',
  'setsid', 'daemon', 'start', 'start-process', 'start-job', 'time',
  'busybox', 'systemd-run',
  'su', 'runuser', 'pkexec',
  'eval', 'source', '.', 'invoke-expression', 'iex', 'call',
]);

const BLOCKED_COMPOUND_SHELL_WORDS = new Set([
  '!', '{', '}', 'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until',
  'do', 'done', 'case', 'esac', 'select', 'function', 'coproc', 'time',
]);

const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh',
  'python', 'python2', 'python3', 'pythonw', 'py', 'pyw', 'node', 'deno', 'ruby', 'perl', 'php',
  'pwsh', 'powershell', 'cmd',
]);

function hasFollowFlag(args: readonly string[]): boolean {
  return args.some((argument) => {
    const normalized = argument.toLowerCase();
    return argument === '-F'
      || /^-[^-]*f[^-]*$/i.test(argument)
      || normalized === '-wait'
      || normalized === '--wait'
      || normalized.startsWith('--follow');
  });
}

function hasInteractiveFlag(args: readonly string[]): boolean {
  return args.some((argument) => {
    const normalized = argument.toLowerCase();
    return /^-[^-]*[it][^-]*$/.test(normalized)
      || normalized === '--interactive'
      || normalized === '--interactive=true'
      || normalized === '--tty'
      || normalized === '--tty=true';
  });
}

function pingHasCount(args: readonly string[], shell: AgentTerminalShell): boolean {
  const countOptions = shell === 'powershell' ? new Set(['-c', '-n']) : new Set(['-c']);
  return args.some((argument, index) =>
    (shell === 'powershell' ? /^-[cn]\d+$/i : /^-c\d+$/i).test(argument)
    || (countOptions.has(argument.toLowerCase()) && /^\d+$/.test(args[index + 1] ?? '')),
  );
}

function interpreterHasProgram(program: string, args: readonly string[]): boolean {
  const normalized = args.map((argument) => argument.toLowerCase());
  if (program === 'cmd') return normalized.includes('/c');
  if (program === 'pwsh' || program === 'powershell') {
    return normalized.some((argument) => argument === '-command' || argument === '-file');
  }
  if (program === 'deno') {
    return normalized.some((argument) => (
      ['eval', 'run', 'task', 'test', 'lint', 'fmt', 'check', 'info', 'doc', 'compile'].includes(argument)
      || argument === '--help'
      || argument === '--version'
    ));
  }
  if (program === 'node') {
    if (normalized.some((argument) => (
      argument === '-e'
      || argument === '--eval'
      || argument.startsWith('--eval=')
      || argument === '-p'
      || argument === '--print'
      || argument.startsWith('--print=')
    ))) return true;
    for (let index = 0; index < args.length; index += 1) {
      if (normalized[index] === '-r' || normalized[index] === '--require') {
        index += 1;
        continue;
      }
      if (!args[index].startsWith('-')) return true;
    }
    return false;
  }
  if (program === 'ruby') {
    if (args.some((argument) => /^-e(?:.+)?$/i.test(argument))) return true;
    for (let index = 0; index < args.length; index += 1) {
      if (normalized[index] === '-r') {
        index += 1;
        continue;
      }
      if (!args[index].startsWith('-')) return true;
    }
    return false;
  }
  if (program === 'perl') {
    if (args.some((argument) => /^-e(?:.+)?$/i.test(argument))) return true;
    for (let index = 0; index < args.length; index += 1) {
      if (/^-M/i.test(args[index]) || /^-I/i.test(args[index])) continue;
      if (!args[index].startsWith('-')) return true;
    }
    return false;
  }
  if (program === 'php') {
    return normalized.some((argument) => argument === '-r' || argument === '-f')
      || args.some((argument) => /^-r.+/i.test(argument))
      || args.some((argument) => !argument.startsWith('-'));
  }
  const isPython = ['python', 'python2', 'python3', 'pythonw', 'py', 'pyw'].includes(program);
  const inlineOptions = isPython ? new Set(['-c', '-m']) : new Set(['-c']);
  if (normalized.some((argument) => inlineOptions.has(argument))) return true;
  if (isPython && args.some((argument) => /^-[cm].+/.test(argument))) return true;
  return args.some((argument) => !argument.startsWith('-'));
}

function interpreterInvocationReason(program: string, args: readonly string[]): string | null {
  const normalized = args.map((argument) => argument.toLowerCase());
  const isPython = ['python', 'python2', 'python3', 'pythonw', 'py', 'pyw'].includes(program);
  if (isPython && args.some((argument) => argument.startsWith('-i') || argument === '--inspect')) {
    return `interactive interpreter mode is blocked: ${program}`;
  }
  if (isPython) {
    const moduleIndex = normalized.indexOf('-m');
    const attachedModule = normalized.find((argument) => /^-m.+/.test(argument));
    const moduleName = moduleIndex >= 0
      ? normalized[moduleIndex + 1]
      : attachedModule?.slice(2);
    if (moduleName && ['code', 'pdb', 'asyncio'].includes(moduleName)) {
      return `interactive interpreter module is blocked: ${program} -m ${moduleName}`;
    }
  }
  if (program === 'deno' && normalized.includes('repl')) {
    return 'interactive interpreter mode is blocked: deno repl';
  }
  if (
    (program === 'node' || program === 'deno')
    && normalized.some((argument) => (
      argument === '--inspect-brk'
      || argument.startsWith('--inspect-brk=')
      || argument === '--inspect-wait'
      || argument.startsWith('--inspect-wait=')
    ))
  ) {
    return `debugger-wait interpreter mode is blocked: ${program}`;
  }
  if (program === 'cmd' && normalized.includes('/k')) {
    return 'persistent command interpreter mode is blocked: cmd /k';
  }
  if (
    (program === 'pwsh' || program === 'powershell')
    && normalized.some((argument) => /^-noe(?:x(?:i(?:t)?)?)?$/.test(argument))
  ) {
    return `persistent command interpreter mode is blocked: ${program} -NoExit`;
  }
  if ((program === 'pwsh' || program === 'powershell') && normalized.includes('-encodedcommand')) {
    return `opaque encoded interpreter command is blocked: ${program}`;
  }
  return null;
}

function inlineInterpreterCode(program: string, args: readonly string[]): string | null {
  const normalized = args.map((argument) => argument.toLowerCase());
  const valueAfter = (options: readonly string[]): string | null => {
    const index = normalized.findIndex((argument) => options.includes(argument));
    return index >= 0 ? args[index + 1] ?? '' : null;
  };
  if (['python', 'python2', 'python3', 'pythonw', 'py', 'pyw'].includes(program)) {
    const separate = valueAfter(['-c']);
    if (separate !== null) return separate;
    const joined = args.find((argument) => /^-c.+/.test(argument));
    return joined?.slice(2) ?? null;
  }
  if (program === 'node') {
    const separate = valueAfter(['-e', '--eval', '-p', '--print']);
    if (separate !== null) return separate;
    const joined = args.find((argument) => /^--(?:eval|print)=/i.test(argument));
    return joined?.slice(joined.indexOf('=') + 1) ?? null;
  }
  if (program === 'ruby') {
    const index = args.findIndex((argument) => /^-e/i.test(argument));
    if (index < 0) return null;
    return args[index].length > 2 ? args[index].slice(2) : args[index + 1] ?? '';
  }
  if (program === 'perl') {
    const index = args.findIndex((argument) => /^-e/i.test(argument));
    if (index < 0) return null;
    return args[index].length > 2 ? args[index].slice(2) : args[index + 1] ?? '';
  }
  if (program === 'php') {
    const separate = valueAfter(['-r']);
    if (separate !== null) return separate;
    const joined = args.find((argument) => /^-r.+/i.test(argument));
    return joined?.slice(2) ?? null;
  }
  if (program === 'deno') {
    const index = normalized.indexOf('eval');
    return index >= 0 ? args[index + 1] ?? '' : null;
  }
  if (program === 'pwsh' || program === 'powershell') {
    const index = normalized.indexOf('-command');
    return index >= 0 ? args.slice(index + 1).join(' ') : null;
  }
  return null;
}

function stripQuotedCodeLiterals(code: string): string {
  let result = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (const character of code) {
    if (escaped) {
      result += ' ';
      escaped = false;
    } else if (quote) {
      if (character === '\\') {
        result += ' ';
        escaped = true;
      } else if (character === quote) {
        result += ' ';
        quote = null;
      } else {
        result += ' ';
      }
    } else if (character === "'" || character === '"' || character === '`') {
      result += ' ';
      quote = character;
    } else {
      result += character;
    }
  }
  return result;
}

function inlineInterpreterInputReason(program: string, code: string): string | null {
  const searchable = stripQuotedCodeLiterals(code);
  const isPython = ['python', 'python2', 'python3', 'pythonw', 'py', 'pyw'].includes(program);
  const pythonRawRisk = isPython && (
    /(?:\/dev\/tty|CONIN\$)/i.test(code)
    || /\b(?:from|import)\s+getpass\b|\btty\.(?:open|setraw|setcbreak)\b/i.test(searchable)
    || /\bfrom\s+(?:builtins|__builtin__)\s+import\s+(?:input|raw_input|help|breakpoint)\b/i.test(code)
    || (
      /\b(?:f|fr|rf)["']/i.test(code)
      && /(?:^|[^\w.])(?:input|raw_input|help|breakpoint|getpass)\s*\(/i.test(code)
    )
  );
  const readsInput = isPython
    ? /(?:^|[^\w.])(?:input|raw_input|help|breakpoint)\s*\(|\b(?:builtins|__builtin__)\.(?:input|raw_input|help|breakpoint)\s*\(|\bpdb\.set_trace\s*\(|\bsys\.stdin\b/i.test(searchable)
    : program === 'node' || program === 'deno'
      ? /\b(?:process|Deno)\.stdin\b|\breadline(?:\/promises)?\b|\.createInterface\s*\(|(?:^|[^\w.])prompt\s*\(/i.test(searchable)
      : program === 'ruby'
        ? /\bSTDIN\b|\$stdin\b|\bReadline\b|(?:^|[^\w.])(?:gets|readline)\b/i.test(searchable)
        : program === 'perl'
          ? /<\s*STDIN\s*>|\breadline\s*(?:\(?\s*STDIN\b)?|\bTerm::ReadKey\b/i.test(searchable)
        : program === 'php'
          ? /\bSTDIN\b|\breadline\s*\(|\bfgets\s*\(/i.test(searchable)
          : program === 'pwsh' || program === 'powershell'
            ? /\bRead-Host\b|\.PromptForChoice\s*\(|\[System\.Console\]::Read(?:Line|Key)?\s*\(|\$Host\.UI\./i.test(searchable)
            : false;
  const interpolationReadsInput = (program === 'node' || program === 'deno')
    ? /`[^`]*\$\{[^}]*(?:\b(?:process|Deno)\.stdin\b|\bprompt\s*\(|\breadline\b)/i.test(code)
    : program === 'ruby'
      ? /["`][^"`]*#\{[^}]*(?:\bSTDIN\b|\$stdin\b|\b(?:gets|readline)\b)/i.test(code)
      : program === 'pwsh' || program === 'powershell'
        ? /"[^"]*\$\([^)]*(?:\bRead-Host\b|\[System\.Console\]::Read|\$Host\.UI\.)/i.test(code)
        : false;
  return pythonRawRisk
    || readsInput
    || interpolationReadsInput
    || /(?:\/dev\/tty|CONIN\$)/i.test(searchable)
    ? `stdin-reading inline interpreter code is blocked: ${program}`
    : null;
}

function inlineInterpreterDetachedProcessReason(program: string, code: string): string | null {
  const searchable = stripQuotedCodeLiterals(code);
  const isPython = ['python', 'python2', 'python3', 'pythonw', 'py', 'pyw'].includes(program);
  if (
    isPython
    && (
      /\b(?:os\.)?(?:setsid|setpgrp|daemon)\s*\(/i.test(searchable)
      || /\bstart_new_session\s*=/i.test(searchable)
      || /\bpreexec_fn\s*=/i.test(searchable)
      || /\bcreationflags\s*=/i.test(searchable)
    )
  ) {
    return `detached inline interpreter process is blocked: ${program}`;
  }
  if (
    (program === 'node' || program === 'deno')
    && (
      /\bdetached\s*:\s*true\b/i.test(searchable)
      || /\[\s*["']detached["']\s*\]\s*:\s*true\b/i.test(code)
    )
  ) {
    return `detached inline interpreter process is blocked: ${program}`;
  }
  if (
    program === 'ruby'
    && /\bProcess\s*\.\s*(?:daemon|setsid|setpgrp)\b/i.test(searchable)
  ) {
    return 'detached inline interpreter process is blocked: ruby';
  }
  if (
    program === 'perl'
    && /\b(?:POSIX\s*::\s*)?setsid\s*\(|\bProc\s*::\s*Daemon\b|\bdaemonize\s*\(/i.test(searchable)
  ) {
    return 'detached inline interpreter process is blocked: perl';
  }
  if (program === 'php' && /\bposix_setsid\s*\(/i.test(searchable)) {
    return 'detached inline interpreter process is blocked: php';
  }
  if (
    (program === 'pwsh' || program === 'powershell')
    && /\bStart-Process\b/i.test(searchable)
    && !/(?:^|\s)-(?:Wait|W)(?:\s|$)/i.test(searchable)
  ) {
    return `background process launch without -Wait is blocked: ${program} Start-Process`;
  }
  return null;
}

function interpreterCommand(program: string, args: readonly string[]): string | null {
  const normalized = args.map((argument) => argument.toLowerCase());
  if (['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'].includes(program)) {
    const index = normalized.findIndex((argument) => /^-[a-z]*c[a-z]*$/.test(argument));
    if (index >= 0) return args[index + 1] ?? null;
    const longCommand = args.find((argument) => argument.startsWith('--command='));
    return longCommand?.slice(longCommand.indexOf('=') + 1) ?? null;
  }
  if (program === 'pwsh' || program === 'powershell') {
    const index = normalized.findIndex((argument) =>
      argument === '-command' || argument === '-encodedcommand');
    return index >= 0 ? args[index + 1] ?? null : null;
  }
  if (program === 'cmd') {
    const index = normalized.findIndex((argument) => argument === '/c' || argument === '/k');
    return index >= 0 ? args.slice(index + 1).join(' ') || null : null;
  }
  return null;
}

function nestedCommandSubstitutions(command: string): string[] {
  const nested: string[] = [];
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (character === '`') {
      let end = index + 1;
      while (end < command.length && command[end] !== '`') {
        if (command[end] === '\\') end += 1;
        end += 1;
      }
      if (end < command.length) {
        nested.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if (character !== '$' || command[index + 1] !== '(') continue;

    let depth = 1;
    let nestedQuote: 'single' | 'double' | null = null;
    let nestedEscaped = false;
    let end = index + 2;
    for (; end < command.length; end += 1) {
      const nestedCharacter = command[end];
      if (nestedEscaped) {
        nestedEscaped = false;
        continue;
      }
      if (nestedQuote === 'single') {
        if (nestedCharacter === "'") nestedQuote = null;
        continue;
      }
      if (nestedCharacter === '\\') {
        nestedEscaped = true;
      } else if (nestedCharacter === "'" && nestedQuote !== 'double') {
        nestedQuote = 'single';
      } else if (nestedCharacter === '"') {
        nestedQuote = nestedQuote === 'double' ? null : 'double';
      } else if (nestedCharacter === '(') {
        depth += 1;
      } else if (nestedCharacter === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      nested.push(command.slice(index + 2, end));
      index = end;
    }
  }
  return nested;
}

function getNonAutomatableCommandReasonInternal(
  command: string,
  depth: number,
  shell: AgentTerminalShell,
): string | null {
  if (depth > 8) return 'excessively nested shell execution is blocked';
  if (depth > 0 && hasBackgroundOperator(command)) return 'Background commands are blocked';
  for (const nested of nestedCommandSubstitutions(command)) {
    const reason = getNonAutomatableCommandReasonInternal(nested, depth + 1, shell);
    if (reason) return reason;
  }
  for (const words of commandSegments(command)) {
    const commandWord = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word))
      ?.toLowerCase();
    if (commandWord && BLOCKED_COMPOUND_SHELL_WORDS.has(commandWord)) {
      return `compound shell syntax cannot guarantee bounded process-tree cleanup: ${commandWord}`;
    }
    const executable = resolveExecutable(words);
    if (!executable) continue;
    const { program, args, interactivePrivilegeWrapper, wrapperReason } = executable;
    if (wrapperReason) return wrapperReason;
    if (interactivePrivilegeWrapper) {
      return `privilege wrapper may prompt for credentials; use non-interactive mode: ${interactivePrivilegeWrapper} -n`;
    }
    if (BLOCKED_PROGRAMS.has(program)) {
      return `interactive or non-terminating program is blocked: ${program}`;
    }
    if (INTERPRETERS.has(program)) {
      const invocationReason = interpreterInvocationReason(program, args);
      if (invocationReason) return invocationReason;
      const inlineCode = inlineInterpreterCode(program, args);
      if (inlineCode !== null) {
        const inputReason = inlineInterpreterInputReason(program, inlineCode);
        if (inputReason) return inputReason;
        const detachedProcessReason = inlineInterpreterDetachedProcessReason(program, inlineCode);
        if (detachedProcessReason) return detachedProcessReason;
      }
      if (!interpreterHasProgram(program, args)) {
        return `interactive interpreter is blocked: ${program}`;
      }
    }
    const nestedInterpreterCommand = interpreterCommand(program, args);
    if (nestedInterpreterCommand) {
      const reason = getNonAutomatableCommandReasonInternal(
        nestedInterpreterCommand,
        depth + 1,
        shell,
      );
      if (reason) return reason;
    }
    if (program === 'exec') return 'commands that replace the bound shell are blocked';
    if (program === 'exit' || program === 'logout') return 'commands that close the bound shell are blocked';
    if (program === 'tail' && hasFollowFlag(args)) return 'unbounded follow output is blocked: tail';
    if (program === 'journalctl' && hasFollowFlag(args)) return 'unbounded follow output is blocked: journalctl';
    if ((program === 'docker' || program === 'kubectl') && args[0] === 'logs' && hasFollowFlag(args.slice(1))) {
      return `unbounded follow output is blocked: ${program} logs`;
    }
    if (
      (program === 'docker' || program === 'podman' || program === 'kubectl')
      && (args[0] === 'attach' || (args[0] === 'exec' && hasInteractiveFlag(args.slice(1))))
    ) {
      return `interactive container session is blocked: ${program} ${args[0]}`;
    }
    if ((program === 'docker' || program === 'podman') && args[0] === 'run' && hasInteractiveFlag(args.slice(1))) {
      return `interactive container session is blocked: ${program} run`;
    }
    if (
      (program === 'docker' || program === 'podman')
      && args[0] === 'run'
      && args.slice(1).some((argument) => (
        /^-[^-]*d[^-]*$/.test(argument)
        || argument === '--detach'
        || argument === '--detach=true'
      ))
    ) {
      return `detached container launch is blocked: ${program} run`;
    }
    if (
      (program === 'docker' || program === 'podman')
      && args[0] === 'exec'
      && args.slice(1).some((argument) => (
        /^-[^-]*d[^-]*$/.test(argument)
        || argument === '--detach'
        || argument === '--detach=true'
      ))
    ) {
      return `detached container execution is blocked: ${program} exec`;
    }
    if (program === 'docker' && args[0] === 'stats' && !args.slice(1).some((argument) => (
      argument === '--no-stream' || argument === '--no-stream=true'
    ))) {
      return 'unbounded streaming output is blocked: docker stats';
    }
    if (program === 'kubectl' && args[0] === 'get' && args.slice(1).some((argument) => (
      argument === '-w'
      || argument === '--watch'
      || argument === '--watch=true'
      || argument === '--watch-only'
    ))) {
      return 'unbounded watch output is blocked: kubectl get';
    }
    if (program === 'free') {
      const repeats = args.some((argument) => (
        argument === '-s'
        || argument === '--seconds'
        || /^-s\d/.test(argument)
        || argument.startsWith('--seconds=')
      ));
      const bounded = args.some((argument, index) => (
        /^-c[1-9]\d*$/.test(argument)
        || /^--count=[1-9]\d*$/.test(argument)
        || ((argument === '-c' || argument === '--count') && /^[1-9]\d*$/.test(args[index + 1] ?? ''))
      ));
      if (repeats && !bounded) return 'unbounded repeat output is blocked: free';
    }
    if (program === 'lsof' && args.some((argument) => /^[+-]r(?:\d+(?:\.\d+)?)?$/i.test(argument))) {
      return 'unbounded repeat output is blocked: lsof';
    }
    if (program === 'netstat' && args.some((argument) => (
      argument === '--continuous' || /^-[^-]*[cw][^-]*$/.test(argument)
    ))) {
      return 'unbounded continuous output is blocked: netstat';
    }
    if (program === 'ss' && args.some((argument) => (
      argument === '--events' || argument === '--kill' || /^-[^-]*[EK][^-]*$/.test(argument)
    ))) {
      return 'event or kill mode is blocked: ss';
    }
    if ((program === 'get-content' || program === 'get-winevent') && hasFollowFlag(args)) {
      return `unbounded follow output is blocked: ${program}`;
    }
    if (program === 'cat') {
      if (!args.some((argument) => !argument.startsWith('-') && argument !== '-')) {
        return 'stdin-consuming cat without a file is blocked';
      }
      if (args.some((argument) => /^\/dev\/(?:tty|stdin|fd\/0)$/.test(
        argument.replace(/\/(?:\.)\//g, '/'),
      ))) {
        return 'stdin-consuming terminal device is blocked: cat';
      }
    }
    if (program === 'ping' && !pingHasCount(args, shell)) {
      return 'unbounded ping without a count is blocked';
    }
  }
  return null;
}

export function getNonAutomatableCommandReason(
  command: string,
  shell: AgentTerminalShell = 'posix',
): string | null {
  return getNonAutomatableCommandReasonInternal(command, 0, shell);
}

function hasIncompleteShellSyntax(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '\\') {
      escaped = true;
    } else if (character === "'" && quote !== 'double') {
      quote = 'single';
    } else if (character === '"') {
      quote = quote === 'double' ? null : 'double';
    }
  }
  if (quote !== null || escaped) return true;
  return /(?:\||&&|\|\|)\s*$/.test(command);
}

function hasBackgroundOperator(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '\\') {
      escaped = true;
    } else if (character === "'" && quote !== 'double') {
      quote = 'single';
    } else if (character === '"') {
      quote = quote === 'double' ? null : 'double';
    } else if (quote === 'double') {
      continue;
    } else if (
      character === '&'
      && command[index - 1] !== '&'
      && command[index + 1] !== '&'
      && command[index - 1] !== '>'
      && command[index - 1] !== '<'
      && command[index + 1] !== '>'
    ) {
      return true;
    }
  }
  return false;
}

function validateCommand(command: string, shell: AgentTerminalShell): string | null {
  if (!command.trim()) return 'Agent terminal command is empty';
  if ([...command].length > AGENT_TERMINAL_COMMAND_LIMIT_CHARS) {
    return 'Agent terminal command exceeds the 8192 character limit';
  }
  if ([...command].some((character) => (
    /\p{Cc}/u.test(character) || character === '\u2028' || character === '\u2029'
  ))) {
    return 'Agent terminal command must be one line without control characters';
  }
  if (hasIncompleteShellSyntax(command)) return 'Incomplete shell syntax is blocked';
  if (hasBackgroundOperator(command)) return 'Background commands are blocked';
  return getNonAutomatableCommandReason(command, shell);
}

function inferredSessionKind(session: TerminalSession): AgentTargetSnapshot['kind'] {
  return session.host === 'local' && session.port === 0 ? 'local' : 'remote';
}

export function validateFrozenAgentTarget(
  target: AgentTargetSnapshot,
  session: TerminalSession | undefined,
  controller: TerminalController | undefined,
): string | null {
  if (!session || !controller) return 'Frozen terminal session is no longer available';
  if (
    session.sessionId !== target.sessionId
    || controller.sessionId !== target.sessionId
    || inferredSessionKind(session) !== target.kind
    || session.host !== target.host
    || session.port !== target.port
    || session.username !== target.username
    || session.profileId !== target.profileId
  ) {
    return 'Frozen terminal target identity no longer matches the live session';
  }
  if (session.status !== 'connected') return 'Frozen terminal session is not connected';
  return null;
}

function validateAuthorization(
  call: AgentToolCall,
  authorization: AgentTerminalExecutionAuthorization,
): string | null {
  if (authorization.decision !== 'authorized') return 'Terminal execution was not explicitly authorized';
  if (!['explicitUserAction', 'explicitUpstreamAuthorization'].includes(authorization.source)) {
    return 'Terminal execution authorization source is invalid';
  }
  if (
    authorization.requestId !== call.requestId
    || authorization.callId !== call.callId
    || authorization.sessionId !== call.target.sessionId
  ) {
    return 'Terminal execution authorization does not match the structured tool call';
  }
  return null;
}

function prepareOutput(
  parser: AgentTerminalBoundaryParser,
  note?: string,
  preserveParserState = false,
): string {
  const captured = preserveParserState ? parser.snapshotCapture() : parser.finishCapture();
  const withoutBoundaryLine = captured.text.replace(/^\r?\n/, '');
  const normalized = renderTerminalText(stripAnsi(withoutBoundaryLine)).trim();
  const redacted = redactTerminalSecrets(normalized);
  const combined = [redacted, note].filter(Boolean).join(redacted && note ? '\n' : '');
  return truncateAiContext(combined, AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES);
}

function toolResult(
  call: AgentToolCall,
  status: AgentToolResult['status'],
  output: string,
  exitCode?: number,
): AgentToolResult {
  return {
    requestId: call.requestId,
    callId: call.callId,
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    output: truncateAiContext(
      redactTerminalSecrets(renderTerminalText(stripAnsi(output))).trim(),
      AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES,
    ),
  };
}

function snapshotToolCall(call: AgentToolCall): AgentToolCall {
  return {
    requestId: call.requestId,
    callId: call.callId,
    name: call.name,
    command: call.command,
    explanation: call.explanation,
    target: { ...call.target },
  };
}

export class AgentTerminalExecutor {
  private readonly nonceFactory: () => string;
  private readonly platform: Platform;
  private readonly activeBySession = new Map<string, ActiveExecution>();
  private readonly quarantinedBySession = new Map<string, Readonly<{
    requestId: string;
    callId: string;
  }>>();

  constructor(options: ExecutorOptions = {}) {
    this.nonceFactory = options.nonceFactory ?? createSecureNonce;
    this.platform = options.platform ?? getPlatform();
  }

  cancel(requestId: string, callId: string): boolean {
    for (const active of this.activeBySession.values()) {
      if (active.requestId === requestId && active.callId === callId) {
        active.cancellation.abort();
        return true;
      }
    }
    return false;
  }

  async execute(input: AuthorizedAgentTerminalExecution): Promise<AgentToolResult> {
    const call = snapshotToolCall(input.toolCall);
    if (call.name !== 'run_terminal_command') {
      return toolResult(call, 'failed', 'Only run_terminal_command can enter the PTY executor');
    }
    const authorizationError = validateAuthorization(call, input.authorization);
    if (authorizationError) return toolResult(call, 'failed', authorizationError);
    const shell: AgentTerminalShell = call.target.kind === 'local' && this.platform === 'windows'
      ? 'powershell'
      : 'posix';
    const commandError = validateCommand(call.command, shell);
    if (commandError) return toolResult(call, 'failed', commandError);

    const session = useTerminalStore.getState().sessions.find(
      (candidate) => candidate.sessionId === call.target.sessionId,
    );
    const controller = terminalRegistry.get(call.target.sessionId);
    const targetError = validateFrozenAgentTarget(call.target, session, controller);
    if (targetError || !controller) return toolResult(call, 'failed', targetError ?? 'Frozen terminal session is unavailable');
    if (this.quarantinedBySession.has(call.target.sessionId)) {
      return toolResult(
        call,
        'failed',
        'A previous Agent command has not confirmed termination in this terminal session',
      );
    }
    if (this.activeBySession.has(call.target.sessionId)) {
      return toolResult(call, 'failed', 'Another Agent command is already running in the frozen terminal session');
    }

    let boundary: AgentTerminalBoundary;
    try {
      boundary = createAgentTerminalBoundary(this.nonceFactory());
    } catch {
      return toolResult(call, 'failed', 'Secure terminal output boundary generation failed');
    }
    let wrapper: string;
    try {
      wrapper = buildAgentTerminalWrapper(
        call.command,
        boundary,
        shell,
        input.isolateReadOnly === true,
      );
    } catch {
      return toolResult(call, 'failed', 'Failed to build a bounded terminal command wrapper');
    }
    const releaseUserInput = controller.suppressUserInput();
    if (controller.hasPendingUserInput()) {
      releaseUserInput();
      return toolResult(
        call,
        'failed',
        'Terminal input line is not empty; submit or clear the pending user input before running an Agent command',
      );
    }
    if (controller.hasUnverifiedUserSubmission()) {
      releaseUserInput();
      return toolResult(
        call,
        'failed',
        'Terminal shell ownership cannot be verified after manual command submission; open or reconnect a session before running an Agent command',
      );
    }
    const parser = new AgentTerminalBoundaryParser(boundary);
    const cancellation = new AbortController();
    const active: ActiveExecution = {
      requestId: call.requestId,
      callId: call.callId,
      cancellation,
    };
    this.activeBySession.set(call.target.sessionId, active);
    const timeoutMs = Number.isFinite(input.timeoutMs) && (input.timeoutMs ?? 0) > 0
      ? Math.floor(input.timeoutMs!)
      : AGENT_TERMINAL_DEFAULT_TIMEOUT_MS;

    try {
      return await new Promise<AgentToolResult>((resolve) => {
        let resolved = false;
        let writeDispatched = false;
        let supervisorMayHaveStarted = false;
        let activeWrapperWrite: Promise<void> | undefined;
        let interruptDispatched = false;
        let timeout: number | undefined;
        let interruptGrace: number | undefined;
        let writePaceTimer: number | undefined;
        let releaseWritePace: (() => void) | undefined;
        let interrupting: Readonly<{
          status: 'failed' | 'cancelled' | 'timedOut';
          note: string;
        }> | undefined;
        let unsubscribeOutput = (): void => {};
        let unsubscribeOutputFilter = (): void => {};
        let unsubscribeLifecycle = (): void => {};
        const onExternalAbort = (): void => cancellation.abort();

        const quarantineIdentity = Object.freeze({
          requestId: call.requestId,
          callId: call.callId,
        });
        let quarantined = false;

        const cleanupControl = (): void => {
          if (timeout !== undefined) window.clearTimeout(timeout);
          if (interruptGrace !== undefined) window.clearTimeout(interruptGrace);
          releaseWritePace?.();
          input.signal?.removeEventListener('abort', onExternalAbort);
          cancellation.signal.removeEventListener('abort', onCancelled);
        };

        const waitForWriteProgress = (): Promise<void> => new Promise((resolveProgress) => {
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            if (writePaceTimer !== undefined) window.clearTimeout(writePaceTimer);
            writePaceTimer = undefined;
            if (releaseWritePace === release) releaseWritePace = undefined;
            resolveProgress();
          };
          releaseWritePace = release;
          writePaceTimer = window.setTimeout(release, PTY_WRITE_PROGRESS_FALLBACK_MS);
        });

        const cleanupSubscriptions = (): void => {
          unsubscribeOutput();
          unsubscribeOutputFilter();
          unsubscribeLifecycle();
          releaseUserInput();
        };

        const releaseQuarantine = (): void => {
          if (!quarantined) return;
          if (this.quarantinedBySession.get(call.target.sessionId) === quarantineIdentity) {
            this.quarantinedBySession.delete(call.target.sessionId);
          }
          quarantined = false;
          cleanupSubscriptions();
        };

        const dispatchInterrupt = (): void => {
          if (interruptDispatched) return;
          interruptDispatched = true;
          void controller.writeInput('\u0003').catch(() => undefined);
        };

        const finalize = (
          status: AgentToolResult['status'],
          exitCode: number | undefined,
          note: string | undefined,
          preserveParserState = false,
          keepSubscriptions = false,
        ): void => {
          if (resolved) return;
          resolved = true;
          cleanupControl();
          if (!keepSubscriptions) cleanupSubscriptions();
          resolve({
            requestId: call.requestId,
            callId: call.callId,
            status,
            ...(exitCode === undefined ? {} : { exitCode }),
            output: prepareOutput(parser, note, preserveParserState),
          });
        };

        const beginInterrupt = (
          status: 'failed' | 'cancelled' | 'timedOut',
          note: string,
        ): void => {
          if (resolved || interrupting) return;
          interrupting = Object.freeze({ status, note });
          if (timeout !== undefined) window.clearTimeout(timeout);
          input.signal?.removeEventListener('abort', onExternalAbort);
          cancellation.signal.removeEventListener('abort', onCancelled);
          if (!writeDispatched || controller.sessionId !== call.target.sessionId) {
            finalize(status, undefined, note);
            return;
          }

          quarantined = true;
          this.quarantinedBySession.set(call.target.sessionId, quarantineIdentity);
          if (!supervisorMayHaveStarted) {
            // Keep submitting the one continued statement. A frontend write
            // acknowledgement does not prove that a clearing Ctrl-C reached
            // the PTY, so abandoning a partial wrapper could leave later input
            // appended to it. Once the final line starts the supervisor, the
            // loop below sends Ctrl-C and waits for its authenticated END.
            releaseWritePace?.();
            interruptGrace = window.setTimeout(() => {
              finalize(status, undefined, note, true, true);
            }, AGENT_TERMINAL_INTERRUPT_GRACE_MS);
            return;
          }

          // A submitted final CR only starts evaluation of the outer wrapper.
          // Interrupting before BEGIN can stop it before the private supervisor
          // exists, leaving no process capable of authenticating termination.
          // Wait until the supervisor has emitted BEGIN before sending Ctrl-C.
          if (parser.hasStarted()) dispatchInterrupt();
          interruptGrace = window.setTimeout(() => {
            finalize(status, undefined, note, true, true);
          }, AGENT_TERMINAL_INTERRUPT_GRACE_MS);
        };

        const onCancelled = (): void => {
          beginInterrupt('cancelled', 'Command cancelled by the user.');
        };

        // These subscriptions are deliberately installed before the one PTY
        // write so even a command that returns in the same event turn cannot
        // outrun output capture.
        unsubscribeOutputFilter = controller.subscribeOutputFilter(
          new AgentTerminalDisplayFilter(boundary, call.command, shell),
        );
        unsubscribeOutput = controller.subscribeOutput((chunk) => {
          releaseWritePace?.();
          // BEGIN cannot be genuine before the final continued input line is
          // submitted. Ignore earlier terminal traffic so an already-running
          // foreground process cannot preempt the protocol while it observes
          // wrapper echo fragments.
          if (!supervisorMayHaveStarted) return;
          const parsed = parser.push(chunk);
          if (interrupting && parser.hasStarted() && !parsed) dispatchInterrupt();
          if (!parsed) return;
          if (resolved) {
            releaseQuarantine();
            return;
          }
          if (interrupting) {
            const { status, note } = interrupting;
            releaseQuarantine();
            finalize(status, undefined, note);
          } else {
            finalize(
              parsed.exitCode === 0 ? 'completed' : 'failed',
              parsed.exitCode,
              undefined,
            );
          }
        });
        unsubscribeLifecycle = controller.subscribeLifecycle((event) => {
          if (event.sessionId !== call.target.sessionId) return;
          if (event.type === 'status' && event.payload.status === 'connected') return;
          if (resolved) {
            releaseQuarantine();
            return;
          }
          if (interrupting) {
            const { status, note } = interrupting;
            releaseQuarantine();
            finalize(status, undefined, note);
          } else {
            finalize('failed', undefined, 'Frozen terminal session closed before command completion.');
          }
        });
        cancellation.signal.addEventListener('abort', onCancelled, { once: true });
        input.signal?.addEventListener('abort', onExternalAbort, { once: true });

        if (input.signal?.aborted) {
          cancellation.abort();
          return;
        }

        // The deadline covers listener readiness as well as command runtime,
        // so a stalled event subscription cannot leave the execution pending
        // forever. Ctrl-C is sent only after a command was actually written.
        timeout = window.setTimeout(() => {
          beginInterrupt('timedOut', `Command timed out after ${timeoutMs} ms.`);
        }, timeoutMs);

        void controller.whenOutputReady().then(() => {
          if (resolved || interrupting) return;
          const liveSession = useTerminalStore.getState().sessions.find(
            (candidate) => candidate.sessionId === call.target.sessionId,
          );
          const reboundController = terminalRegistry.get(call.target.sessionId);
          const postSubscriptionError = validateFrozenAgentTarget(
            call.target,
            liveSession,
            reboundController,
          );
          if (postSubscriptionError || reboundController !== controller) {
            finalize(
              'failed',
              undefined,
              postSubscriptionError ?? 'Frozen terminal controller changed before execution.',
            );
            return;
          }

          writeDispatched = true;
          const chunks = createAgentTerminalInputChunks(wrapper, shell);
          void (async () => {
            for (let index = 0; index < chunks.length; index += 1) {
              if (resolved && !quarantined) return;
              const isFinalChunk = index === chunks.length - 1;
              const progress = !isFinalChunk
                ? waitForWriteProgress()
                : undefined;
              if (isFinalChunk) supervisorMayHaveStarted = true;
              activeWrapperWrite = controller.writeInput(chunks[index]);
              await activeWrapperWrite;
              activeWrapperWrite = undefined;
              if (progress) await progress;
            }
            if (interrupting && quarantined && parser.hasStarted()) {
              dispatchInterrupt();
            }
          })().catch(() => {
            releaseWritePace?.();
            if (resolved || interrupting) return;
            beginInterrupt(
              'failed',
              'Failed to write the command to the frozen terminal session.',
            );
          });
        }).catch(() => {
          finalize(
            'failed',
            undefined,
            'Failed to subscribe to output from the frozen terminal session.',
          );
        });
      });
    } finally {
      if (this.activeBySession.get(call.target.sessionId) === active) {
        this.activeBySession.delete(call.target.sessionId);
      }
    }
  }
}

export const agentTerminalExecutor = new AgentTerminalExecutor();

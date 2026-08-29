import { terminalRegistry, type TerminalController } from '@/components/terminal/registry/terminal-registry';
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
export const AGENT_TERMINAL_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
export const AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const AGENT_TERMINAL_COMMAND_LIMIT_CHARS = 8_192;

const BOUNDARY_PREFIX = 'TERMBRIDGE_M2_';
const BOUNDARY_ENTROPY_BYTES = 24;
const RECORD_SEPARATOR = '\u001e';
const UNIT_SEPARATOR = '\u001f';
const MAX_EXIT_CODE_TOKEN_CHARS = 20;
const CAPTURE_OMISSION_MARKER = '\n[... terminal output beyond the 2 MiB capture boundary omitted ...]\n';

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
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AgentTerminalBoundary {
  readonly marker: string;
  readonly beginToken: string;
  readonly endPrefix: string;
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

  constructor(private readonly boundary: AgentTerminalBoundary) {}

  push(chunk: string): BoundaryParseResult | null {
    if (!chunk || this.state === 'completed') return null;
    this.pending += chunk;

    if (this.state === 'awaitingStart') {
      const start = this.pending.indexOf(this.boundary.beginToken);
      if (start === -1) {
        this.pending = this.pending.slice(
          -Math.max(0, this.boundary.beginToken.length - 1),
        );
        return null;
      }
      this.pending = this.pending.slice(start + this.boundary.beginToken.length);
      this.state = 'capturing';
    }

    while (this.state === 'capturing') {
      const endStart = this.pending.indexOf(this.boundary.endPrefix);
      if (endStart === -1) {
        const safeLength = Math.max(0, this.pending.length - this.boundary.endPrefix.length + 1);
        this.capture.push(this.pending.slice(0, safeLength));
        this.pending = this.pending.slice(safeLength);
        return null;
      }

      this.capture.push(this.pending.slice(0, endStart));
      this.pending = this.pending.slice(endStart);
      const codeStart = this.boundary.endPrefix.length;
      const terminator = this.pending.indexOf(UNIT_SEPARATOR, codeStart);
      if (terminator === -1) {
        // A forged or coincidental end prefix must not turn pending parser
        // state into an unbounded side channel around the 2 MiB capture cap.
        if (this.pending.length - codeStart <= MAX_EXIT_CODE_TOKEN_CHARS) return null;
        this.capture.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      const code = this.pending.slice(codeStart, terminator);
      if (!/^-?\d+$/.test(code)) {
        this.capture.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }

      const exitCode = Number(code);
      if (!Number.isSafeInteger(exitCode)) {
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
    if (this.state === 'capturing' && this.pending) {
      this.capture.push(this.pending);
      this.pending = '';
    }
    this.finalized = this.capture.finish();
    return this.finalized;
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
    beginToken: `${RECORD_SEPARATOR}${marker}:BEGIN${UNIT_SEPARATOR}`,
    endPrefix: `${RECORD_SEPARATOR}${marker}:END:`,
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildPosixWrapper(command: string, boundary: AgentTerminalBoundary): string {
  const nonce = boundary.marker.slice(BOUNDARY_PREFIX.length);
  const split = Math.floor(boundary.marker.length / 2);
  const markerFirst = boundary.marker.slice(0, split);
  const markerSecond = boundary.marker.slice(split);
  const variable = (name: string): string => `__tb_${name}_${nonce}`;
  const markerVar = variable('marker');
  const commandVar = variable('command');
  const exitVar = variable('exit');
  const pagerSetVar = variable('pager_set');
  const pagerValueVar = variable('pager_value');
  const gitPagerSetVar = variable('git_pager_set');
  const gitPagerValueVar = variable('git_pager_value');
  const systemdPagerSetVar = variable('systemd_pager_set');
  const systemdPagerValueVar = variable('systemd_pager_value');
  const restore = (name: string, setVar: string, valueVar: string): string =>
    `if [ "$${setVar}" = x ]; then ${name}="$${valueVar}"; export ${name}; else unset ${name}; fi`;

  return [
    `${markerVar}=${quotePosix(markerFirst)}${quotePosix(markerSecond)}`,
    `${commandVar}=${quotePosix(command)}`,
    `${pagerSetVar}=\${PAGER+x}`,
    `${pagerValueVar}=\${PAGER-}`,
    `${gitPagerSetVar}=\${GIT_PAGER+x}`,
    `${gitPagerValueVar}=\${GIT_PAGER-}`,
    `${systemdPagerSetVar}=\${SYSTEMD_PAGER+x}`,
    `${systemdPagerValueVar}=\${SYSTEMD_PAGER-}`,
    `printf '\\036%s:BEGIN\\037\\n' "$${markerVar}"`,
    'PAGER=cat; GIT_PAGER=cat; SYSTEMD_PAGER=cat; export PAGER GIT_PAGER SYSTEMD_PAGER',
    `eval "$${commandVar}"`,
    `${exitVar}=$?`,
    restore('PAGER', pagerSetVar, pagerValueVar),
    restore('GIT_PAGER', gitPagerSetVar, gitPagerValueVar),
    restore('SYSTEMD_PAGER', systemdPagerSetVar, systemdPagerValueVar),
    `printf '\\036%s:END:%d\\037\\n' "$${markerVar}" "$${exitVar}"`,
    `unset ${markerVar} ${commandVar} ${exitVar} ${pagerSetVar} ${pagerValueVar} ${gitPagerSetVar} ${gitPagerValueVar} ${systemdPagerSetVar} ${systemdPagerValueVar}`,
  ].join('; ');
}

function buildPowerShellWrapper(command: string, boundary: AgentTerminalBoundary): string {
  const nonce = boundary.marker.slice(BOUNDARY_PREFIX.length);
  const split = Math.floor(boundary.marker.length / 2);
  const markerFirst = boundary.marker.slice(0, split);
  const markerSecond = boundary.marker.slice(split);
  const variable = (name: string): string => `$__tb_${name}_${nonce}`;
  const markerVar = variable('marker');
  const commandVar = variable('command');
  const exitVar = variable('exit');
  const okVar = variable('ok');
  const pagerHadVar = variable('pager_had');
  const pagerValueVar = variable('pager_value');
  const gitPagerHadVar = variable('git_pager_had');
  const gitPagerValueVar = variable('git_pager_value');
  const systemdPagerHadVar = variable('systemd_pager_had');
  const systemdPagerValueVar = variable('systemd_pager_value');
  const restore = (name: string, hadVar: string, valueVar: string): string =>
    `if (${hadVar}) { $env:${name}=${valueVar} } else { Remove-Item Env:${name} -ErrorAction SilentlyContinue }`;

  return [
    `${markerVar}=${quotePowerShell(markerFirst)}+${quotePowerShell(markerSecond)}`,
    `${commandVar}=${quotePowerShell(command)}`,
    `${pagerHadVar}=Test-Path Env:PAGER`,
    `${pagerValueVar}=$env:PAGER`,
    `${gitPagerHadVar}=Test-Path Env:GIT_PAGER`,
    `${gitPagerValueVar}=$env:GIT_PAGER`,
    `${systemdPagerHadVar}=Test-Path Env:SYSTEMD_PAGER`,
    `${systemdPagerValueVar}=$env:SYSTEMD_PAGER`,
    `Write-Host (-join ([char]30,${markerVar},':BEGIN',[char]31))`,
    `$env:PAGER='cat'; $env:GIT_PAGER='cat'; $env:SYSTEMD_PAGER='cat'`,
    '$global:LASTEXITCODE=$null',
    `Invoke-Expression ${commandVar}`,
    `${okVar}=$?`,
    `${exitVar}=if (${okVar}) { 0 } elseif ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 1 }`,
    restore('PAGER', pagerHadVar, pagerValueVar),
    restore('GIT_PAGER', gitPagerHadVar, gitPagerValueVar),
    restore('SYSTEMD_PAGER', systemdPagerHadVar, systemdPagerValueVar),
    `Write-Host (-join ([char]30,${markerVar},':END:',${exitVar},[char]31))`,
    `$global:LASTEXITCODE=${exitVar}`,
    `Remove-Variable ${[
      markerVar,
      commandVar,
      exitVar,
      okVar,
      pagerHadVar,
      pagerValueVar,
      gitPagerHadVar,
      gitPagerValueVar,
      systemdPagerHadVar,
      systemdPagerValueVar,
    ].map((name) => name.slice(1)).join(',')} -ErrorAction SilentlyContinue`,
  ].join('; ');
}

export function buildAgentTerminalWrapper(
  command: string,
  boundary: AgentTerminalBoundary,
  shell: AgentTerminalShell,
): string {
  return shell === 'powershell'
    ? buildPowerShellWrapper(command, boundary)
    : buildPosixWrapper(command, boundary);
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

function resolveExecutable(words: readonly string[]): { program: string; args: string[] } | null {
  let index = 0;
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
      while (index < words.length && (words[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]))) index += 1;
      continue;
    }
    if (wrapper === 'sudo' || wrapper === 'doas') {
      index += 1;
      while (index < words.length && words[index].startsWith('-')) {
        const option = words[index];
        index += 1;
        if (WRAPPER_OPTIONS_WITH_VALUES.has(option)) index += 1;
      }
      continue;
    }
    if (wrapper === 'nice' || wrapper === 'timeout' || wrapper === 'gtimeout') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const option = words[index];
        index += 1;
        if (option === '-n' || option === '--signal' || option === '--kill-after') index += 1;
      }
      if (wrapper === 'timeout' || wrapper === 'gtimeout') index += 1;
      continue;
    }
    return { program: basename(words[index]), args: words.slice(index + 1) };
  }
  return null;
}

const BLOCKED_PROGRAMS = new Set([
  'vi', 'vim', 'view', 'nvim', 'nano', 'emacs', 'pico', 'joe',
  'less', 'more', 'most', 'man', 'info',
  'ssh', 'sftp', 'scp', 'mosh', 'telnet', 'ftp',
  'top', 'htop', 'btop', 'watch', 'yes', 'fzf', 'lazygit', 'ranger', 'mc',
  'tmux', 'screen', 'lynx', 'w3m',
  'read', 'read-host', 'pause', 'select',
  'mysql', 'mariadb', 'psql', 'sqlite3', 'redis-cli',
]);

const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh',
  'python', 'python2', 'python3', 'node', 'deno', 'ruby', 'irb', 'php',
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
    return normalized === '-i'
      || normalized === '-t'
      || normalized === '-it'
      || normalized === '-ti'
      || normalized === '--interactive'
      || normalized === '--tty';
  });
}

function pingHasCount(args: readonly string[]): boolean {
  return args.some((argument, index) =>
    /^-[cn]\d+$/i.test(argument)
    || ((argument === '-c' || argument === '-n') && /^\d+$/.test(args[index + 1] ?? '')),
  );
}

function interpreterHasProgram(program: string, args: readonly string[]): boolean {
  if (program === 'cmd') return args.some((argument) => /^\/(?:c|k)$/i.test(argument));
  const inlineOptions = program === 'python' || program === 'python2' || program === 'python3'
    ? new Set(['-c', '-m'])
    : program === 'node' || program === 'ruby' || program === 'php'
      ? new Set(['-e', '-r'])
      : program === 'pwsh' || program === 'powershell'
        ? new Set(['-command', '-file', '-encodedcommand'])
        : new Set(['-c']);
  if (args.some((argument) => inlineOptions.has(argument.toLowerCase()))) return true;
  return args.some((argument) => !argument.startsWith('-'));
}

function interpreterCommand(program: string, args: readonly string[]): string | null {
  const normalized = args.map((argument) => argument.toLowerCase());
  if (['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'].includes(program)) {
    const index = normalized.indexOf('-c');
    return index >= 0 ? args[index + 1] ?? null : null;
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

function getNonAutomatableCommandReasonInternal(command: string, depth: number): string | null {
  if (depth > 8) return 'excessively nested shell execution is blocked';
  for (const nested of nestedCommandSubstitutions(command)) {
    const reason = getNonAutomatableCommandReasonInternal(nested, depth + 1);
    if (reason) return reason;
  }
  for (const words of commandSegments(command)) {
    const executable = resolveExecutable(words);
    if (!executable) continue;
    const { program, args } = executable;
    if (BLOCKED_PROGRAMS.has(program)) {
      return `interactive or non-terminating program is blocked: ${program}`;
    }
    if (INTERPRETERS.has(program) && !interpreterHasProgram(program, args)) {
      return `interactive interpreter is blocked: ${program}`;
    }
    const nestedInterpreterCommand = interpreterCommand(program, args);
    if (nestedInterpreterCommand) {
      const reason = getNonAutomatableCommandReasonInternal(
        nestedInterpreterCommand,
        depth + 1,
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
    if ((program === 'get-content' || program === 'get-winevent') && hasFollowFlag(args)) {
      return `unbounded follow output is blocked: ${program}`;
    }
    if (program === 'cat' && !args.some((argument) => !argument.startsWith('-') && argument !== '-')) {
      return 'stdin-consuming cat without a file is blocked';
    }
    if (program === 'ping' && !pingHasCount(args)) {
      return 'unbounded ping without a count is blocked';
    }
  }
  return null;
}

export function getNonAutomatableCommandReason(command: string): string | null {
  return getNonAutomatableCommandReasonInternal(command, 0);
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

function validateCommand(command: string): string | null {
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
  return getNonAutomatableCommandReason(command);
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

function prepareOutput(parser: AgentTerminalBoundaryParser, note?: string): string {
  const captured = parser.finishCapture();
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
    const commandError = validateCommand(call.command);
    if (commandError) return toolResult(call, 'failed', commandError);

    const session = useTerminalStore.getState().sessions.find(
      (candidate) => candidate.sessionId === call.target.sessionId,
    );
    const controller = terminalRegistry.get(call.target.sessionId);
    const targetError = validateFrozenAgentTarget(call.target, session, controller);
    if (targetError || !controller) return toolResult(call, 'failed', targetError ?? 'Frozen terminal session is unavailable');
    if (this.activeBySession.has(call.target.sessionId)) {
      return toolResult(call, 'failed', 'Another Agent command is already running in the frozen terminal session');
    }

    let boundary: AgentTerminalBoundary;
    try {
      boundary = createAgentTerminalBoundary(this.nonceFactory());
    } catch {
      return toolResult(call, 'failed', 'Secure terminal output boundary generation failed');
    }
    const shell: AgentTerminalShell = call.target.kind === 'local' && this.platform === 'windows'
      ? 'powershell'
      : 'posix';
    const wrapper = buildAgentTerminalWrapper(call.command, boundary, shell);
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
        let settled = false;
        let writeDispatched = false;
        let timeout: number | undefined;
        let unsubscribeOutput = (): void => {};
        let unsubscribeLifecycle = (): void => {};
        const onExternalAbort = (): void => cancellation.abort();

        const cleanup = (): void => {
          if (timeout !== undefined) window.clearTimeout(timeout);
          unsubscribeOutput();
          unsubscribeLifecycle();
          input.signal?.removeEventListener('abort', onExternalAbort);
          cancellation.signal.removeEventListener('abort', onCancelled);
        };

        const settle = (
          status: AgentToolResult['status'],
          exitCode: number | undefined,
          note: string | undefined,
          interrupt: boolean,
        ): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (
            interrupt
            && writeDispatched
            && controller.sessionId === call.target.sessionId
          ) {
            // Cancellation completion must not depend on a potentially stuck
            // transport acknowledgement; invoking writeInput queues Ctrl-C on
            // the same PTY and the rejection is intentionally contained.
            void controller.writeInput('\u0003').catch(() => undefined);
          }
          resolve({
            requestId: call.requestId,
            callId: call.callId,
            status,
            ...(exitCode === undefined ? {} : { exitCode }),
            output: prepareOutput(parser, note),
          });
        };

        const onCancelled = (): void => {
          settle('cancelled', undefined, 'Command cancelled by the user.', true);
        };

        // These subscriptions are deliberately installed before the one PTY
        // write so even a command that returns in the same event turn cannot
        // outrun output capture.
        unsubscribeOutput = controller.subscribeOutput((chunk) => {
          const parsed = parser.push(chunk);
          if (!parsed) return;
          settle(
            parsed.exitCode === 0 ? 'completed' : 'failed',
            parsed.exitCode,
            undefined,
            false,
          );
        });
        unsubscribeLifecycle = controller.subscribeLifecycle((event) => {
          if (event.sessionId !== call.target.sessionId) return;
          if (event.type === 'status' && event.payload.status === 'connected') return;
          settle('failed', undefined, 'Frozen terminal session closed before command completion.', false);
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
          settle('timedOut', undefined, `Command timed out after ${timeoutMs} ms.`, true);
        }, timeoutMs);

        void controller.whenOutputReady().then(() => {
          if (settled) return;
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
            settle(
              'failed',
              undefined,
              postSubscriptionError ?? 'Frozen terminal controller changed before execution.',
              false,
            );
            return;
          }

          writeDispatched = true;
          void controller.writeInput(`${wrapper}\r`).catch(() => {
            settle(
              'failed',
              undefined,
              'Failed to write the command to the frozen terminal session.',
              false,
            );
          });
        }).catch(() => {
          settle(
            'failed',
            undefined,
            'Failed to subscribe to output from the frozen terminal session.',
            false,
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

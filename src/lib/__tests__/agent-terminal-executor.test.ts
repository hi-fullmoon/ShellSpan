import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as TauriEvent, EventCallback } from '@tauri-apps/api/event';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { getRecentTerminalOutput } from '@/lib/terminal-output-buffer';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentTargetSnapshot, AgentToolCall } from '@/types/agent';
import {
  AGENT_TERMINAL_CAPTURE_LIMIT_BYTES,
  AGENT_TERMINAL_COMMAND_LIMIT_CHARS,
  AGENT_TERMINAL_INTERRUPT_GRACE_MS,
  AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES,
  AgentTerminalBoundaryParser,
  AgentTerminalDisplayFilter,
  AgentTerminalExecutor,
  buildAgentTerminalWrapper,
  createAgentTerminalBoundary,
  createAgentTerminalFrames,
  createAgentTerminalInputChunks,
  getNonAutomatableCommandReason,
  validateFrozenAgentTarget,
  type AgentTerminalExecutionAuthorization,
} from '../agent-terminal-executor';

const terminalEvents = vi.hoisted(() => {
  const data = new Map<string, EventCallback<string>>();
  const status = new Map<string, EventCallback<{
    sessionId: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
  }>>();
  const closed = new Map<string, EventCallback<{
    sessionId: string;
    reasonKind: 'local_close' | 'controller_dropped' | 'remote_exit' | 'transport_disconnect' | 'error';
    retryable: boolean;
  }>>();

  const event = <T>(sessionId: string, payload: T): TauriEvent<T> => ({
    event: `test:${sessionId}`,
    id: 1,
    payload,
  });

  return {
    data,
    status,
    closed,
    reset() {
      data.clear();
      status.clear();
      closed.clear();
    },
    emitData(sessionId: string, payload: string) {
      data.get(sessionId)?.(event(sessionId, payload));
    },
    emitClosed(sessionId: string) {
      closed.get(sessionId)?.(event(sessionId, {
        sessionId,
        reasonKind: 'transport_disconnect',
        retryable: true,
      }));
    },
  };
});

vi.mock('@/lib/tauri', () => ({
  invokeGetSessionStatus: vi.fn(async (sessionId: string) => ({
    sessionId,
    status: 'connected',
    message: 'ready',
  })),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeOpenUrl: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn(async (sessionId: string, callback: EventCallback<string>) => {
    terminalEvents.data.set(sessionId, callback);
    return () => {
      if (terminalEvents.data.get(sessionId) === callback) terminalEvents.data.delete(sessionId);
    };
  }),
  listenToSshStatus: vi.fn(async (sessionId: string, callback: EventCallback<{
    sessionId: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
  }>) => {
    terminalEvents.status.set(sessionId, callback);
    return () => {
      if (terminalEvents.status.get(sessionId) === callback) terminalEvents.status.delete(sessionId);
    };
  }),
  listenToSshClosed: vi.fn(async (sessionId: string, callback: EventCallback<{
    sessionId: string;
    reasonKind: 'local_close' | 'controller_dropped' | 'remote_exit' | 'transport_disconnect' | 'error';
    retryable: boolean;
  }>) => {
    terminalEvents.closed.set(sessionId, callback);
    return () => {
      if (terminalEvents.closed.get(sessionId) === callback) terminalEvents.closed.delete(sessionId);
    };
  }),
}));

const NONCE = '0123456789abcdef'.repeat(3);
const COMPLETION_CAPABILITY = 'fedcba9876543210'.repeat(3);
const initialTerminalState = useTerminalStore.getState();

function testFrames(boundary: ReturnType<typeof createAgentTerminalBoundary>) {
  return createAgentTerminalFrames(boundary, COMPLETION_CAPABILITY);
}

function decodePowerShellCommand(value: string): string {
  return Buffer.from(value, 'base64').toString('utf16le');
}

function collapsePowerShellPtyLines(value: string): string {
  const collapsed = value.replace(/'\+`\n'/g, '').replace(/ `\n/g, ' ');
  const stagingChunks = [...collapsed.matchAll(/\.Append\('([A-Za-z0-9+/=]+)'\)/g)];
  return stagingChunks.length > 0
    ? Buffer.from(stagingChunks.map((match) => match[1]).join(''), 'base64').toString('utf8')
    : collapsed;
}

function extractPowerShellStringAssignment(wrapper: string, variablePrefix: string): string {
  const logical = collapsePowerShellPtyLines(wrapper);
  const match = new RegExp(`\\$__tb_${variablePrefix}_[^=]+='((?:[^']|'')*)';`).exec(logical);
  expect(match).not.toBeNull();
  return match![1].replace(/''/g, "'");
}

function remoteTarget(sessionId = 'session-1'): AgentTargetSnapshot {
  return {
    kind: 'remote',
    sessionId,
    profileId: 'profile-1',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  };
}

function toolCall(command: string, target = remoteTarget()): AgentToolCall {
  return {
    requestId: 'request-1',
    callId: 'call-1',
    name: 'run_terminal_command',
    command,
    explanation: 'Run the next verified step.',
    target,
  };
}

function authorization(call = toolCall('pwd')): AgentTerminalExecutionAuthorization {
  return {
    decision: 'authorized',
    source: 'explicitUserAction',
    requestId: call.requestId,
    callId: call.callId,
    sessionId: call.target.sessionId,
  };
}

async function createRemoteController(sessionId = 'session-1') {
  useTerminalStore.getState().addSession({
    sessionId,
    title: sessionId,
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  }, 'profile-1');
  useTerminalStore.getState().setStatus(sessionId, { sessionId, status: 'connected' });
  const controller = terminalRegistry.create(
    sessionId,
    useTerminalStore.getState().setStatus,
    useTerminalStore.getState().setClosed,
    (currentSessionId) => useTerminalStore.getState().sessions.find(
      (session) => session.sessionId === currentSessionId,
    )?.status ?? 'disconnected',
    vi.fn(),
  );
  await vi.waitFor(() => expect(terminalEvents.data.has(sessionId)).toBe(true));
  return controller;
}

describe('Agent M2 terminal boundary parser', () => {
  it('publishes only a SHA-256 commitment before the command runs', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const frames = testFrames(boundary);

    expect(frames.beginToken).toBe(
      `${boundary.beginPrefix}e944e4b688d2c07c7d9fde7b4b1fb0675b090edc8186820199625f4f9976c9d5\u0007`,
    );
    expect(boundary.beginPrefix).toBe(`\u001b]6973;${boundary.marker}:BEGIN:`);
    expect(frames.beginToken).not.toContain(COMPLETION_CAPABILITY);
    expect(frames.endPrefix).toContain(COMPLETION_CAPABILITY);
  });

  it('handles split markers and a glued output/end/prompt packet', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    const start = testFrames(boundary).beginToken;
    for (const piece of [start.slice(0, 7), start.slice(7, 31), start.slice(31)]) {
      expect(parser.push(piece)).toBeNull();
    }
    const result = parser.push(`\r\nfirst\r\nsecond${testFrames(boundary).endPrefix}7\u0007next-prompt`);

    expect(result).toEqual({ exitCode: 7 });
    expect(parser.finishCapture().text).toBe('\r\nfirst\r\nsecond');
  });

  it('ignores terminal echo text until the control-framed high-entropy begin marker', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    const wrapperEcho = `printf '\\036%s:BEGIN\\037' '${boundary.marker.slice(0, 20)}''${boundary.marker.slice(20)}'`;

    expect(parser.push(`${wrapperEcho}\r\n${boundary.marker}:BEGIN\r\n`)).toBeNull();
    expect(parser.push(`${testFrames(boundary).beginToken}\r\nreal-output${testFrames(boundary).endPrefix}0\u0007`)).toEqual({
      exitCode: 0,
    });
    expect(parser.finishCapture().text).toBe('\r\nreal-output');
  });

  it('treats an overlong forged exit token as output and still finds the real boundary', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);

    parser.push(`${testFrames(boundary).beginToken}\nstart${testFrames(boundary).endPrefix}${'9'.repeat(64)}`);
    expect(parser.push(`\nfinish${testFrames(boundary).endPrefix}0\u0007`)).toEqual({ exitCode: 0 });
    expect(parser.finishCapture().text).toContain('finish');
  });

  it('ignores a split forged frame with a guessed capability and captures trailing output', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    const guessedEnd = `${boundary.endPrefix}${'a'.repeat(COMPLETION_CAPABILITY.length)}:`;

    expect(parser.push(`${testFrames(boundary).beginToken}\nstart${guessedEnd.slice(0, 29)}`)).toBeNull();
    expect(parser.push(`${guessedEnd.slice(29)}0\u0007trailing-output`)).toBeNull();
    expect(parser.push(`${testFrames(boundary).endPrefix}9\u0007prompt`)).toEqual({ exitCode: 9 });

    const captured = parser.finishCapture().text;
    expect(captured).toContain(guessedEnd);
    expect(captured).toContain('trailing-output');
    expect(captured).not.toContain('prompt');
  });

  it('preserves tail output around an unauthenticated snapshot candidate without leaking it', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    parser.push(
      `${testFrames(boundary).beginToken}\nstart${boundary.endPrefix}not-a-frame trailing-output`,
    );

    const snapshot = parser.snapshotCapture().text;
    expect(snapshot).toContain('start');
    expect(snapshot).toContain('not-a-frame trailing-output');
    expect(snapshot).not.toContain(boundary.endPrefix);
  });

  it('never authenticates the deterministic setup-failure sentinel', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const failureFrames = createAgentTerminalFrames(boundary, '0'.repeat(48));
    const parser = new AgentTerminalBoundaryParser(boundary);

    expect(parser.push(`${failureFrames.beginToken}${failureFrames.endPrefix}0\u0007`)).toBeNull();
    expect(parser.push(`${failureFrames.endPrefix}125\u0007`)).toBeNull();
    expect(parser.finishCapture().text).toContain('125');
  });

  it('keeps capture memory bounded while retaining both ends of oversized output', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    parser.push(testFrames(boundary).beginToken);
    parser.push(`\nhead-${'x'.repeat(AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 128)}-tail-你`);
    expect(parser.push(`${testFrames(boundary).endPrefix}0\u0007`)).toEqual({ exitCode: 0 });

    const captured = parser.finishCapture();
    expect(captured.truncated).toBe(true);
    expect(captured.text).toContain('head-');
    expect(captured.text).toContain('-tail-你');
    expect(captured.text).toContain('2 MiB capture boundary');
    expect(captured.text).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(captured.text).length).toBeLessThanOrEqual(
      AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 128,
    );
  });
});

describe('Agent M2 terminal display filter', () => {
  it.each(['posix', 'powershell'] as const)(
    'replaces a split %s wrapper echo with the original command and hides boundary records',
    (shell) => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const command = 'kimi --version';
      const wrapper = buildAgentTerminalWrapper(command, boundary, shell);
      const filter = new AgentTerminalDisplayFilter(boundary, command, shell);
      const stream = `${wrapper}\r\n${testFrames(boundary).beginToken}\r\n0.38.0\r\n${testFrames(boundary).endPrefix}0\u0007[root@host ~]# `;
      const cuts = [9, wrapper.length - 3, wrapper.length + 11, stream.length - 17];
      const pieces = cuts.map((end, index) => stream.slice(index === 0 ? 0 : cuts[index - 1], end));
      pieces.push(stream.slice(cuts[cuts.length - 1]));

      const visible = `${pieces.map((piece) => filter.push(piece)).join('')}${filter.finish()}`;

      expect(visible).toBe('kimi --version\r\n0.38.0\r\n[root@host ~]# ');
      expect(visible).not.toContain('__tb_');
      expect(visible).not.toContain('SHELLSPAN_M2_');
      expect(visible).not.toContain('\u001b]6973;');
      expect(visible).not.toContain('\u0007');
    },
  );

  it('keeps the decorated PowerShell continuation echo hidden until BEGIN arrives', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const command = 'docker info';
    const wrapper = buildAgentTerminalWrapper(command, boundary, 'powershell');
    const filter = new AgentTerminalDisplayFilter(
      boundary,
      command,
      'powershell',
      wrapper.length,
    );
    const echoedChunks = createAgentTerminalInputChunks(wrapper, 'powershell').map(
      (chunk) => {
        // PSReadLine decorates syntax tokens and emits cursor/color control
        // sequences while accepting each continued physical input line.
        const decorated = chunk.slice(0, -1).replace(
          /([A-Za-z0-9_$]+|.)/g,
          '\u001b[?25l\u001b[1m\u001b[38;5;120m\u001b[92m$1\u001b[0m\u001b[?25h',
        );
        return `${decorated}\r\n>> `;
      },
    );

    expect(echoedChunks.join('').length).toBeGreaterThan(64 * 1024);
    const visible = [
      ...echoedChunks.map((chunk) => filter.push(chunk)),
      filter.push(
        `${testFrames(boundary).beginToken}\r\nDocker details\r\n${testFrames(boundary).endPrefix}0\u0007PS C:\\> `,
      ),
      filter.finish(),
    ].join('');

    expect(visible).toBe('docker info\r\nDocker details\r\nPS C:\\> ');
    expect(visible).not.toContain('__tb_');
    expect(visible).not.toContain('>> ');
  });

  it.each([
    ['posix', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', ['/usr/local', 'eval "']] as const,
    ['powershell', '.EnvironmentVariables.Clear()', ["EnvironmentVariables['PSModulePath']=''", '$PSHOME', '. $__tb_script_']] as const,
  ])('runs auto-approved read-only commands with a fixed trusted %s path', (shell, expected, excluded) => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const wrapper = buildAgentTerminalWrapper('df -h', boundary, shell, true);
    const logicalWrapper = shell === 'powershell'
      ? collapsePowerShellPtyLines(wrapper)
      : wrapper.replace(/\\\n/g, '').replace(/''/g, '');

    expect(logicalWrapper).toContain(expected);
    for (const value of excluded) expect(logicalWrapper).not.toContain(value);
  });

  it.each([
    ['posix', ['/usr/bin/env -u __tb_marker_', '/bin/sh -c', '</dev/null', '/usr/bin/printf'], 'eval "'] as const,
    ['powershell', ['[System.Diagnostics.ProcessStartInfo]', 'RedirectStandardInput', 'CreateNoWindow', '.WaitForExit(100)', "'taskkill.exe'"], '. $__tb_script_'] as const,
  ])('keeps the completion capability outside the %s command process', (shell, expected, excluded) => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const wrapper = buildAgentTerminalWrapper('printf ready', boundary, shell);
    const logicalWrapper = shell === 'powershell'
      ? collapsePowerShellPtyLines(wrapper)
      : wrapper.replace(/\\\n/g, '').replace(/''/g, '');

    for (const value of expected) expect(logicalWrapper).toContain(value);
    expect(logicalWrapper).not.toContain(excluded);
    if (shell === 'posix') {
      expect(logicalWrapper).toContain('LC_ALL=C /bin/kill -0 "-$__tb_p"');
      expect(logicalWrapper).toContain('No such process');
      expect(logicalWrapper).toContain('termination could not be confirmed');
    }
  });

  it('uses bounded Windows waits and a private Job Object supervisor', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const command = "Write-Output 'command-must-not-enter-child-arguments'";
    const wrapper = buildAgentTerminalWrapper(command, boundary, 'powershell', true);
    const logicalWrapper = collapsePowerShellPtyLines(wrapper);
    const outerArgumentsPrefix = `$__tb_process_info_${NONCE}.Arguments=`;
    const argumentsStart = logicalWrapper.indexOf(outerArgumentsPrefix);
    const argumentsEnd = logicalWrapper.indexOf(';', argumentsStart);
    const supervisorMatch = /-EncodedCommand ([A-Za-z0-9+/=]+)/
      .exec(logicalWrapper.slice(argumentsStart, argumentsEnd));
    expect(supervisorMatch).not.toBeNull();
    const supervisorArguments = `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${supervisorMatch![1]}`;
    const supervisorBootstrap = decodePowerShellCommand(supervisorMatch![1]);
    const privateSupervisor = extractPowerShellStringAssignment(wrapper, 'supervisor_script');
    const commandBootstrapMatch = /-EncodedCommand ([A-Za-z0-9+/=]+)/
      .exec(privateSupervisor);
    expect(commandBootstrapMatch).not.toBeNull();
    const commandBootstrap = decodePowerShellCommand(commandBootstrapMatch![1]);

    expect(logicalWrapper).toContain('finally {');
    expect(logicalWrapper).not.toContain('Set-PSDebug');
    expect(logicalWrapper).toContain('.WaitForExit(100)');
    expect(logicalWrapper).toContain('.WaitForExit(2000)');
    expect(logicalWrapper).toContain(".EnvironmentVariables['PATH']");
    expect(logicalWrapper).toContain(".EnvironmentVariables['PSModulePath']");
    expect(logicalWrapper).toContain("[System.IO.Path]::GetDirectoryName($__tb_process_info_");
    expect(logicalWrapper).not.toContain('.WaitForExit()');
    expect(logicalWrapper.slice(argumentsStart, argumentsEnd)).not.toContain(command);
    expect(privateSupervisor).toContain('ShellSpanAgentJob');
    expect(privateSupervisor).toContain('EnableKillOnClose');
    expect(privateSupervisor).toContain('AssignProcessToJobObject');
    expect(privateSupervisor).toContain('TerminateJobObject');
    expect(privateSupervisor).toContain('QueryInformationJobObject');
    expect(privateSupervisor).toContain('GetActiveProcessCount');
    expect(privateSupervisor).toContain('ActiveProcesses');
    expect(privateSupervisor).toContain('UtcNow.AddSeconds(2)');
    expect(privateSupervisor).toContain('Test-ShellSpanParent');
    expect(privateSupervisor).toContain('$__shellspanInfo.CreateNoWindow=$false');
    expect(privateSupervisor).toContain("[char]27,']6973;'");
    expect(logicalWrapper).toContain(`$__tb_process_info_${NONCE}.CreateNoWindow=$false`);
    expect(privateSupervisor).toContain('.WaitForExit(0)');
    expect(privateSupervisor).toContain('SHELLSPAN_AGENT_PARENT_PID');
    expect(privateSupervisor).not.toContain(
      '$__shellspanGate.Set(); $__shellspanGate.Dispose()',
    );
    expect(privateSupervisor).not.toMatch(
      /CleanupConfirmed=\[ShellSpanAgentJob\]::TerminateJobObject/,
    );
    // CreateProcess limits the complete UTF-16 command line to 32,767
    // characters. Reserve MAX_PATH for the fixed PowerShell executable.
    expect(260 + 1 + supervisorArguments.length + 1).toBeLessThan(32_767);
    expect(supervisorBootstrap).toContain('[Console]::In.ReadToEnd()');
    expect(supervisorBootstrap).toContain('SHA256]::Create()');
    expect(supervisorBootstrap).toContain('ScriptBlock]::Create');
    expect(logicalWrapper).toContain('.StandardInput.Write($__tb_supervisor_script_');
    expect(privateSupervisor).not.toContain(command);
    expect(commandBootstrap).toContain('EventWaitHandle]::OpenExisting');
    expect(commandBootstrap).toContain('SHELLSPAN_AGENT_GATE');
    expect(commandBootstrap).toContain(
      '$__shellspanChildOk=$?;$__shellspanChildNative=$global:LASTEXITCODE',
    );
    expect(commandBootstrap).toContain('. $__shellspanChildScript');
    expect(commandBootstrap).not.toContain('SHELLSPAN_AGENT_MARKER');
    for (const name of [
      'APPDOMAIN_MANAGER_ASM',
      'COR_ENABLE_PROFILING',
      'CORECLR_ENABLE_PROFILING',
      'DOTNET_STARTUP_HOOKS',
    ]) {
      expect(logicalWrapper).toContain(name);
    }
    expect(logicalWrapper).toContain("-match '^(?:COMPLUS_|COR_|CORECLR_)'");
  });

  it('removes boundary records when shell echo is disabled without hiding command output', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const filter = new AgentTerminalDisplayFilter(boundary, 'printf ready', 'posix');

    const visible = [
      filter.push(testFrames(boundary).beginToken.slice(0, 13)),
      filter.push(`${testFrames(boundary).beginToken.slice(13)}\r`),
      filter.push(`\nready\r\n${testFrames(boundary).endPrefix}0\u0007$ `),
      filter.finish(),
    ].join('');

    expect(visible).toBe('ready\r\n$ ');
  });

  it('keeps a forged end record visible and removes the later valid record', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const filter = new AgentTerminalDisplayFilter(boundary, 'printf ready', 'posix');
    const forged = `${testFrames(boundary).endPrefix}not-an-exit\u0007`;

    const visible = filter.push(
      `${testFrames(boundary).beginToken}\nstart${forged}finish${testFrames(boundary).endPrefix}7\u0007prompt`,
    );

    expect(visible).toBe(`start${forged}finishprompt`);
  });

  it('fails open when a wrapper echo never reaches its begin record', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const command = 'printf ready';
    const wrapper = buildAgentTerminalWrapper(command, boundary, 'posix');
    const filter = new AgentTerminalDisplayFilter(boundary, command, 'posix');
    const incomplete = wrapper.slice(0, 300);

    expect(filter.push(incomplete)).toBe('');
    expect(filter.finish()).toBe(incomplete);
  });

  it('preserves every byte of an invalid begin candidate', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const filter = new AgentTerminalDisplayFilter(boundary, 'printf ready', 'posix');
    const invalid = `${boundary.beginPrefix}not-a-valid-commitment\u0007after`;

    expect(`${filter.push(invalid)}${filter.finish()}`).toBe(invalid);
  });

  it('does not flush a split completion capability when the terminal closes', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const filter = new AgentTerminalDisplayFilter(boundary, 'printf ready', 'posix');
    const partialEnd = `${boundary.endPrefix}${COMPLETION_CAPABILITY.slice(0, 16)}`;

    const visible = `${filter.push(`${testFrames(boundary).beginToken}\nready${partialEnd}`)}${filter.finish()}`;

    expect(visible).toBe('ready');
    expect(visible).not.toContain(COMPLETION_CAPABILITY.slice(0, 16));
    expect(visible).not.toContain('SHELLSPAN_M2_');
  });
});

describe('Agent M2 command wrapper and local blocking', () => {
  it.each(['posix', 'powershell'] as const)(
    'builds a safely submitted %s wrapper without echoing the actual framed marker',
    (shell) => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const wrapper = buildAgentTerminalWrapper("printf '%s' \"it's-safe\"", boundary, shell);

      if (shell === 'powershell') {
        const lines = wrapper.split('\n');
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every((line) => new TextEncoder().encode(line).length <= 1_024)).toBe(true);
        const chunks = createAgentTerminalInputChunks(wrapper, shell);
        expect(chunks.map((chunk) => chunk.slice(0, -1)).join('\n')).toBe(wrapper);
        expect(chunks.every((chunk) => chunk.endsWith('\r'))).toBe(true);
      } else {
        expect(wrapper.split('\n').every((line) => new TextEncoder().encode(line).length < 256)).toBe(true);
        expect(wrapper).toContain('\\\n');
        const chunks = createAgentTerminalInputChunks(wrapper, shell);
        expect(chunks.join('')).toBe(`${wrapper}\r`);
        expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length < 256)).toBe(true);
        expect(wrapper).toContain('unset LD_PRELOAD');
        expect(wrapper).toContain('LD_TRACE_LOADED_OBJECTS');
        expect(wrapper).toContain('; exec /usr/bin/env');
        expect(wrapper).toContain('-u LD_TRACE_LOADED_OBJECTS');
      }
      expect(wrapper).not.toContain(testFrames(boundary).beginToken);
      expect(wrapper).not.toContain(testFrames(boundary).endPrefix);
      expect(wrapper).toContain(boundary.marker.slice(0, Math.floor(boundary.marker.length / 2)));
      expect(wrapper).toContain(boundary.marker.slice(Math.floor(boundary.marker.length / 2)));
      if (shell === 'powershell') {
        const logicalWrapper = collapsePowerShellPtyLines(wrapper);
        expect(logicalWrapper).toContain('-EncodedCommand');
        expect(logicalWrapper).toContain('[System.Diagnostics.ProcessStartInfo]');
        expect(logicalWrapper).toContain('RedirectStandardInput');
        expect(logicalWrapper).toContain('$global:LASTEXITCODE');
        expect(logicalWrapper).not.toContain('Invoke-Expression');
      }
    },
  );

  it('keeps maximum-size hostile PowerShell input in bounded continued PTY lines', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const unit = "'`😀";
    const command = unit.repeat(Math.floor(AGENT_TERMINAL_COMMAND_LIMIT_CHARS / unit.length));
    const wrapper = buildAgentTerminalWrapper(command, boundary, 'powershell');
    const lines = wrapper.split('\n');

    expect(command.length).toBeLessThanOrEqual(AGENT_TERMINAL_COMMAND_LIMIT_CHARS);
    expect(lines.every((line) => new TextEncoder().encode(line).length <= 1_024)).toBe(true);
    expect(extractPowerShellStringAssignment(wrapper, 'command')).toBe(command);
  });

  it('keeps worst-case POSIX quoting below the physical PTY line budget', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const command = `${"'".repeat(256)}${'😀'.repeat(128)}`;
    const wrapper = buildAgentTerminalWrapper(command, boundary, 'posix');

    expect(wrapper.split('\n').every(
      (line) => new TextEncoder().encode(line).length < 256,
    )).toBe(true);
  });

  it.each([
    'vim /etc/hosts',
    'sudo less /var/log/system.log',
    'ssh nested.example.com',
    'tail -f /var/log/system.log',
    'journalctl --follow -u nginx',
    'docker logs -f app',
    'kubectl logs app --follow=true',
    'watch systemctl status nginx',
    'docker exec -it app sh',
    'podman attach app',
    'kubectl exec --tty --interactive app -- sh',
    'docker exec -d app sleep 60',
    'docker exec --interactive=true app sh',
    'docker stats',
    'kubectl get pods --watch',
    'free -s 1',
    'lsof -r 1',
    'netstat -c',
    'ss -E',
    'Read-Host "Password"',
    'ping -n example.com',
    'cat',
    'cat /dev/tty',
    'ping example.com',
    "bash -c 'ssh nested.example.com'",
    "bash -lc 'sudo -n setsid sleep 60'",
    "sh -ec 'setsid sleep 60'",
    "sh -c 'sleep 60 &'",
    "bash -c 'printf ready; sleep 60 &'",
    'echo "$(tail -f /var/log/system.log)"',
    "python3 -c 'input()'",
    "python3 '-cinput()'",
    "python3 -c 'import getpass; getpass.getpass()'",
    "python3 -c 'from getpass import getpass as gp; gp()'",
    "python3 -c 'open(\"/dev/tty\").read()'",
    "python3 -c 'print(f\"{input()}\")'",
    "python3 -c 'import builtins; builtins.input()'",
    "env -u TOKEN python3 -c 'input()'",
    "env -S 'python3 -c input()'",
    'python3 -i script.py',
    'python3 -m pdb script.py',
    "node -e 'process.stdin.resume()'",
    "node -e 'console.log(`${process.stdin.read()}`)'",
    "node --inspect-brk -e 'console.log(1)'",
    'node -r ts-node/register',
    "ruby -e 'STDIN.gets'",
    "ruby -e 'puts \"#{STDIN.gets}\"'",
    'ruby -r json',
    'deno repl',
    'cmd /k echo done',
    "powershell -NoExit -Command 'Write-Output done'",
    "powershell -NoEx -Command 'Write-Output done'",
    "powershell -Command '$Host.UI.PromptForChoice(\"title\", \"message\", @(), 0)'",
    "powershell -Command 'Start-Process powershell -ArgumentList sleep,60'",
    'powershell -EncodedCommand ZQBjAGgAbwAgAGQAbwBuAGUA',
    'sudo ls /tmp',
    'sudo -n ls /tmp',
    'doas ls /tmp',
    'doas -n ls /tmp',
    '! sudo -n setsid sleep 60',
    '{ sudo -n setsid sleep 60; }',
    'if true; then sudo -n setsid sleep 60; fi',
    'time sudo -n setsid sleep 60',
    '/usr/bin/time sudo -n setsid sleep 60',
    'command time sudo -n setsid sleep 60',
    'busybox setsid sleep 60',
    'docker run -d alpine sleep 60',
    'systemd-run --user sleep 60',
    'env -P /usr/bin sudo -n sleep 60',
    'env -a ignored sudo -n sleep 60',
    'timeout -s TERM 5 sudo -n sleep 60',
    'timeout -k 1 5 sudo -n sleep 60',
    'nice --adjustment 5 sudo -n sleep 60',
    "eval 'sudo -n sleep 60'",
    'x=sudo; "$x" -n sleep 60',
    'source ./possibly-interactive.sh',
    '. ./possibly-interactive.sh',
    "powershell -Command '$x=\"Start-Process\"; & $x powershell'",
    "powershell -Command 'Invoke-Expression \"Start-Process powershell\"'",
    "node -e \"require('child_process').spawn('sleep',['60'],{detached:true,stdio:'ignore'}).unref()\"",
    "node -e \"require('child_process').spawn('sleep',[],{['detached']:true})\"",
    "ruby -e 'Process.daemon; sleep 60'",
    "perl -MPOSIX -e 'POSIX::setsid(); exec \"sleep\", \"60\"'",
    "python3 -c 'import os,subprocess; subprocess.Popen([\"sleep\",\"60\"], preexec_fn=os.setsid)'",
    "python3 -c 'import subprocess; subprocess.Popen([\"sleep\",\"60\"], start_new_session=bool(1))'",
    "php -r 'posix_setsid(); sleep(60);'",
    'Start-Process powershell -ArgumentList sleep,60',
    'exit',
  ])('blocks commands that cannot safely auto-complete: %s', (command) => {
    expect(getNonAutomatableCommandReason(command)).not.toBeNull();
  });

  it.each([
    'echo ssh nested.example.com',
    'tail -n 50 /var/log/system.log',
    'journalctl -u nginx -n 50',
    'docker logs --tail 50 app',
    'ping -c 2 example.com',
    "python3 -c 'print(1)'",
    "python3 '-cprint(1)'",
    "python3 -c 'print(\"input()\")'",
    "python3 -c 'print(\"getpass\")'",
    'python3 -I script.py',
    'python3 script.py',
    "node -e 'console.log(1)'",
    'node app.js',
    "ruby -e 'puts 1'",
    'ruby app.rb',
    "perl -e 'print 1'",
    "php -r 'echo 1;'",
  ])('allows bounded commands: %s', (command) => {
    expect(getNonAutomatableCommandReason(command)).toBeNull();
  });

  it('uses the platform-specific bounded ping count option', () => {
    expect(getNonAutomatableCommandReason('ping -n 2 example.com')).not.toBeNull();
    expect(getNonAutomatableCommandReason('ping -n 2 example.com', 'powershell')).toBeNull();
  });
});

describe('Agent M2 PTY executor', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { invokeWriteSession } = await import('@/lib/tauri');
    vi.mocked(invokeWriteSession).mockReset().mockResolvedValue(undefined);
    terminalEvents.reset();
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminalState, true);
    await createRemoteController();
  });

  afterEach(() => {
    vi.useRealTimers();
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminalState, true);
  });

  it('subscribes before writing and captures a fast ANSI-colored result', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('printf fast');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(
        sessionId,
        `${testFrames(boundary).beginToken}\r\n\u001b[31mfast\u001b[0m\r\n${testFrames(boundary).endPrefix}0\u0007`,
      );
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result).toEqual({
      requestId: 'request-1',
      callId: 'call-1',
      status: 'completed',
      exitCode: 0,
      output: 'fast',
    });
    expect(invokeWriteSession).toHaveBeenCalledWith('session-1', expect.stringMatching(/\r$/));
    expect(vi.mocked(invokeWriteSession).mock.calls.length).toBeGreaterThan(1);
  });

  it('paces POSIX wrapper lines on PTY echo instead of bulk-writing canonical input', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('printf paced');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) {
        terminalEvents.emitData(
          sessionId,
          `${testFrames(boundary).beginToken}\r\npaced${testFrames(boundary).endPrefix}0\u0007`,
        );
      }
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });
    const writes = vi.mocked(invokeWriteSession).mock.calls.map(([, data]) => data);
    const wrapper = buildAgentTerminalWrapper(call.command, boundary, 'posix');

    expect(result).toMatchObject({ status: 'completed', exitCode: 0, output: 'paced' });
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join('')).toBe(`${wrapper}\r`);
    expect(writes.every((chunk) => new TextEncoder().encode(chunk).length < 256)).toBe(true);
  });

  it('keeps user input locked and finishes a mid-submission cancellation before one Ctrl-C', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    const wrapper = buildAgentTerminalWrapper(call.command, boundary, 'posix');
    let releaseFirstWrite!: () => void;
    let firstWrite = true;
    vi.mocked(invokeWriteSession).mockImplementation((sessionId, data) => {
      if (data === '\u0003') {
        terminalEvents.emitData(sessionId, `${testFrames(boundary).endPrefix}130\u0007`);
        return Promise.resolve();
      }
      if (firstWrite) {
        firstWrite = false;
        return new Promise<void>((resolve) => {
          releaseFirstWrite = () => {
            terminalEvents.emitData(sessionId, data);
            resolve();
          };
        });
      }
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) terminalEvents.emitData(sessionId, testFrames(boundary).beginToken);
      return Promise.resolve();
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const controller = terminalRegistry.get('session-1')!;

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    controller.simulateInput('must-not-interleave');
    expect(vi.mocked(invokeWriteSession).mock.calls.flat()).not.toContain('must-not-interleave');
    expect(executor.cancel(call.requestId, call.callId)).toBe(true);
    releaseFirstWrite();
    const result = await pending;
    const writes = vi.mocked(invokeWriteSession).mock.calls.map(([, data]) => data);
    const interruptIndex = writes.indexOf('\u0003');

    expect(result.status).toBe('cancelled');
    expect(interruptIndex).toBeGreaterThan(0);
    expect(writes.slice(0, interruptIndex).join('')).toBe(`${wrapper}\r`);
    expect(writes.filter((data) => data === '\u0003')).toHaveLength(1);

    controller.simulateInput('after-release');
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenLastCalledWith(
      'session-1',
      'after-release',
    ));
  });

  it('waits for supervisor BEGIN before interrupting a cancelled wrapper upload', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    let releaseFirstWrite!: () => void;
    let firstWrite = true;
    vi.mocked(invokeWriteSession).mockImplementation((sessionId, data) => {
      if (data === '\u0003') {
        terminalEvents.emitData(sessionId, `${testFrames(boundary).endPrefix}130\u0007`);
        return Promise.resolve();
      }
      if (firstWrite) {
        firstWrite = false;
        return new Promise<void>((resolve) => {
          releaseFirstWrite = () => {
            terminalEvents.emitData(sessionId, data);
            resolve();
          };
        });
      }
      terminalEvents.emitData(sessionId, data);
      return Promise.resolve();
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'windows' });
    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });

    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    expect(executor.cancel(call.requestId, call.callId)).toBe(true);
    releaseFirstWrite();
    await vi.waitFor(() => expect(
      vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r')),
    ).toBe(true));
    expect(invokeWriteSession).not.toHaveBeenCalledWith('session-1', '\u0003');

    terminalEvents.emitData('session-1', testFrames(boundary).beginToken);
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledWith('session-1', '\u0003'));
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('sends only one Ctrl-C when cancellation races the final wrapper write', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    let releaseFinalWrite!: () => void;
    vi.mocked(invokeWriteSession).mockImplementation((sessionId, data) => {
      if (data === '\u0003') return Promise.resolve();
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) {
        terminalEvents.emitData(sessionId, testFrames(boundary).beginToken);
        return new Promise<void>((resolve) => {
          releaseFinalWrite = resolve;
        });
      }
      return Promise.resolve();
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });

    await vi.waitFor(() => expect(
      vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r')),
    ).toBe(true));
    expect(executor.cancel(call.requestId, call.callId)).toBe(true);
    await vi.waitFor(() => expect(
      vi.mocked(invokeWriteSession).mock.calls.filter(([, data]) => data === '\u0003'),
    ).toHaveLength(1));
    releaseFinalWrite();
    await Promise.resolve();
    expect(vi.mocked(invokeWriteSession).mock.calls.filter(([, data]) => data === '\u0003'))
      .toHaveLength(1);
    terminalEvents.emitData('session-1', `${testFrames(boundary).endPrefix}130\u0007`);

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('refuses to append an Agent wrapper to pending user input', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    controller.simulateInput('unfinished command');
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledWith(
      'session-1',
      'unfinished command',
    ));
    const callsBeforeAgent = vi.mocked(invokeWriteSession).mock.calls.length;
    const call = toolCall('pwd');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('input line is not empty'),
    });
    expect(invokeWriteSession).toHaveBeenCalledTimes(callsBeforeAgent);
  });

  it('fails closed after a manual command may have changed shell ownership', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    controller.simulateInput('sleep 60\r');
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledWith(
      'session-1',
      'sleep 60\r',
    ));
    const callsBeforeAgent = vi.mocked(invokeWriteSession).mock.calls.length;
    const call = toolCall('pwd');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    await expect(executor.execute({ toolCall: call, authorization: authorization(call) }))
      .resolves.toMatchObject({
        status: 'failed',
        output: expect.stringContaining('shell ownership cannot be verified'),
      });
    expect(invokeWriteSession).toHaveBeenCalledTimes(callsBeforeAgent);
  });

  it('keeps a user shell continuation marked as pending after Enter', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    controller.simulateInput('echo \\\r');
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledWith(
      'session-1',
      'echo \\\r',
    ));
    const call = toolCall('pwd');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    await expect(executor.execute({ toolCall: call, authorization: authorization(call) }))
      .resolves.toMatchObject({
        status: 'failed',
        output: expect.stringContaining('input line is not empty'),
      });
  });

  it.each([
    'echo ok &&\r',
    'cat <<EOF\r',
  ])('keeps compound and heredoc input pending: %j', async (userInput) => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    controller.simulateInput(userInput);
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledWith(
      'session-1',
      userInput,
    ));
    const call = toolCall('pwd');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    await expect(executor.execute({ toolCall: call, authorization: authorization(call) }))
      .resolves.toMatchObject({
        status: 'failed',
        output: expect.stringContaining('input line is not empty'),
      });
  });

  it('clears a completed heredoc without treating a quoted operator as syntax', () => {
    const controller = terminalRegistry.get('session-1')!;

    controller.simulateInput("echo '<<EOF'\r");
    expect(controller.hasPendingUserInput()).toBe(false);
    controller.simulateInput('cat <<EOF\rbody\rEOF\r');
    expect(controller.hasPendingUserInput()).toBe(false);
  });

  it('shows only the command, command output, and prompt in the terminal and context cache', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('kimi --version');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      const stream = `${testFrames(boundary).beginToken}\r\n0.38.0\r\n${testFrames(boundary).endPrefix}0\u0007[root@host ~]# `;
      const split = Math.floor(testFrames(boundary).beginToken.length / 2);
      terminalEvents.emitData(sessionId, stream.slice(0, split));
      terminalEvents.emitData(sessionId, stream.slice(split));
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });
    const controller = terminalRegistry.get('session-1')!;
    await vi.waitFor(() => {
      const terminalText = Array.from(
        { length: controller.terminal.buffer.active.length },
        (_, index) => controller.terminal.buffer.active.getLine(index)?.translateToString(true) ?? '',
      ).join('\n');
      expect(terminalText).toContain('kimi --version');
      expect(terminalText).toContain('0.38.0');
      expect(terminalText).toContain('[root@host ~]#');
      expect(terminalText).not.toContain('__tb_');
      expect(terminalText).not.toContain('SHELLSPAN_M2_');
    });
    const cached = getRecentTerminalOutput('session-1', 20);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('0.38.0');
    expect(cached).toContain('kimi --version');
    expect(cached).toContain('0.38.0');
    expect(cached).toContain('[root@host ~]#');
    expect(cached).not.toContain('__tb_');
    expect(cached).not.toContain('SHELLSPAN_M2_');
  });

  it('does not write until the underlying PTY output listener is ready', async () => {
    const { invokeWriteSession, listenToSshData } = await import('@/lib/tauri');
    terminalRegistry.disposeAll();
    terminalEvents.reset();
    useTerminalStore.setState(initialTerminalState, true);

    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    vi.mocked(listenToSshData).mockImplementationOnce(async (sessionId, callback) => {
      await listenerGate;
      terminalEvents.data.set(sessionId, callback);
      return () => {
        if (terminalEvents.data.get(sessionId) === callback) terminalEvents.data.delete(sessionId);
      };
    });

    useTerminalStore.getState().addSession({
      sessionId: 'session-1',
      title: 'session-1',
      host: 'server.example.com',
      port: 22,
      username: 'operator',
    }, 'profile-1');
    useTerminalStore.getState().setStatus('session-1', { sessionId: 'session-1', status: 'connected' });
    terminalRegistry.create(
      'session-1',
      useTerminalStore.getState().setStatus,
      useTerminalStore.getState().setClosed,
      (sessionId) => useTerminalStore.getState().sessions.find(
        (session) => session.sessionId === sessionId,
      )?.status ?? 'disconnected',
      vi.fn(),
    );

    const call = toolCall('printf ready');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(
        sessionId,
        `${testFrames(boundary).beginToken}\r\nready${testFrames(boundary).endPrefix}0\u0007`,
      );
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await Promise.resolve();
    expect(invokeWriteSession).not.toHaveBeenCalled();

    releaseListener();
    const result = await pending;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ready');
    expect(vi.mocked(invokeWriteSession).mock.calls.length).toBeGreaterThan(1);
  });

  it('returns non-zero exit status and redacts output before the model boundary', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('false');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(sessionId, testFrames(boundary).beginToken.slice(0, 19));
      terminalEvents.emitData(sessionId, `${testFrames(boundary).beginToken.slice(19)}\r\npassword=hunter2\r\n${testFrames(boundary).endPrefix.slice(0, 23)}`);
      terminalEvents.emitData(sessionId, `${testFrames(boundary).endPrefix.slice(23)}23\u0007`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(23);
    expect(result.output).toBe('password=[REDACTED]');
    expect(result.output).not.toContain('hunter2');
  });

  it('caps long output at 2 MiB and trims the redacted model result to 64 KiB', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    vi.spyOn(controller.terminal, 'write').mockImplementation((_data, callback) => callback?.());
    const call = toolCall('generate-long-output');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(sessionId, `${testFrames(boundary).beginToken}\nhead-${'x'.repeat(AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 256)}`);
      terminalEvents.emitData(sessionId, `\npassword=long-secret\nlatest-tail-你${testFrames(boundary).endPrefix}0\u0007`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('latest-tail-你');
    expect(result.output).not.toContain('long-secret');
    expect(result.output).not.toContain('\u001b');
    expect(result.output).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(
      AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES,
    );
  });

  it('times out and sends Ctrl-C to the same frozen PTY', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) {
        terminalEvents.emitData(sessionId, `${testFrames(boundary).beginToken}\r\nrunning`);
      }
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({
      toolCall: call,
      authorization: authorization(call),
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r'))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    terminalEvents.emitData(
      'session-1',
      `cleanup-tail${testFrames(boundary).endPrefix}130\u0007`,
    );
    const result = await pending;

    expect(result.status).toBe('timedOut');
    expect(result.output).toContain('timed out after 100 ms');
    expect(result.output).toContain('cleanup-tail');
  });

  it('uses the 120 second timeout when no override is supplied', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 180');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) terminalEvents.emitData(sessionId, testFrames(boundary).beginToken);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r'))).toBe(true);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(invokeWriteSession).not.toHaveBeenCalledWith('session-1', '\u0003');
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    terminalEvents.emitData(
      'session-1',
      `${testFrames(boundary).endPrefix}130\u0007`,
    );
    const result = await pending;

    expect(result.status).toBe('timedOut');
    expect(result.output).toContain('120000 ms');
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
  });

  it('captures a cleanup END that arrives after the Windows Job cleanup window', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) terminalEvents.emitData(sessionId, testFrames(boundary).beginToken);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const pending = executor.execute({
      toolCall: call,
      authorization: authorization(call),
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    await vi.advanceTimersByTimeAsync(2_500);
    terminalEvents.emitData(
      'session-1',
      `late-cleanup-tail${testFrames(boundary).endPrefix}130\u0007`,
    );
    const result = await pending;

    expect(result.status).toBe('timedOut');
    expect(result.output).toContain('late-cleanup-tail');
  });

  it('cancels on user stop and sends Ctrl-C to the same frozen PTY', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) terminalEvents.emitData(sessionId, testFrames(boundary).beginToken);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.waitFor(() => expect(
      vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r')),
    ).toBe(true));
    expect(executor.cancel(call.requestId, call.callId)).toBe(true);
    terminalEvents.emitData(
      'session-1',
      `\r\ncancel-cleanup${testFrames(boundary).endPrefix}130\u0007`,
    );
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.output).toContain('cancelled by the user');
    expect(result.output).toContain('cancel-cleanup');
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    expect(executor.cancel(call.requestId, call.callId)).toBe(false);
  });

  it('quarantines a PTY after cancellation until the wrapper confirms termination', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) {
        terminalEvents.emitData(sessionId, `${testFrames(boundary).beginToken}\r\nrunning`);
      }
    });
    const firstCall = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({
      toolCall: firstCall,
      authorization: authorization(firstCall),
    });
    await vi.waitFor(() => expect(
      vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r')),
    ).toBe(true));
    const writesBeforeCancel = vi.mocked(invokeWriteSession).mock.calls.length;
    const split = Math.floor(testFrames(boundary).endPrefix.length / 2);
    expect(executor.cancel(firstCall.requestId, firstCall.callId)).toBe(true);

    const blockedCall = {
      ...toolCall('uptime'),
      requestId: 'request-2',
      callId: 'call-2',
    };
    await expect(executor.execute({
      toolCall: blockedCall,
      authorization: authorization(blockedCall),
    })).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('has not confirmed termination'),
    });
    expect(invokeWriteSession).toHaveBeenCalledTimes(writesBeforeCancel + 1);

    terminalEvents.emitData(
      'session-1',
      `cleanup-after-cancel${testFrames(boundary).endPrefix.slice(0, split)}`,
    );
    terminalEvents.emitData(
      'session-1',
      `${testFrames(boundary).endPrefix.slice(split)}130\u0007`,
    );
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled.output).toContain('running');
    expect(cancelled.output).toContain('cleanup-after-cancel');
    expect(cancelled.output).not.toContain('SHELLSPAN_M2_');
    expect(cancelled.output).not.toContain(COMPLETION_CAPABILITY);
    const resumedCall = {
      ...toolCall('uptime'),
      requestId: 'request-3',
      callId: 'call-3',
    };
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(
        sessionId,
        `${testFrames(boundary).beginToken}\r\nready${testFrames(boundary).endPrefix}0\u0007`,
      );
    });

    await expect(executor.execute({
      toolCall: resumedCall,
      authorization: authorization(resumedCall),
    })).resolves.toMatchObject({ status: 'completed', output: 'ready' });
  });

  it('reassembles a split completion frame after timeout and releases quarantine', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      if (data === '\u0003') return;
      terminalEvents.emitData(sessionId, data);
      if (data.endsWith('\r')) {
        terminalEvents.emitData(
          sessionId,
          `${testFrames(boundary).beginToken}\r\nwaiting${testFrames(boundary).endPrefix}13`,
        );
      }
    });
    const firstCall = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({
      toolCall: firstCall,
      authorization: authorization(firstCall),
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(invokeWriteSession).mock.calls.some(([, data]) => data.endsWith('\r'))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    terminalEvents.emitData('session-1', '0\u0007');
    const timedOut = await pending;
    expect(timedOut).toMatchObject({
      status: 'timedOut',
      output: expect.stringContaining('waiting'),
    });
    expect(timedOut.output).not.toContain('SHELLSPAN_M2_');
    expect(timedOut.output).not.toContain(COMPLETION_CAPABILITY);

    const resumedCall = {
      ...toolCall('uptime'),
      requestId: 'request-2',
      callId: 'call-2',
    };
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(
        sessionId,
        `${testFrames(boundary).beginToken}\r\nready${testFrames(boundary).endPrefix}0\u0007`,
      );
    });

    await expect(executor.execute({
      toolCall: resumedCall,
      authorization: authorization(resumedCall),
    })).resolves.toMatchObject({ status: 'completed', output: 'ready' });
  });

  it('keeps cancellation quarantine when a dispatched PTY write is later rejected', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    let rejectWrite!: (error: Error) => void;
    vi.mocked(invokeWriteSession).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectWrite = reject;
    }));
    const firstCall = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({
      toolCall: firstCall,
      authorization: authorization(firstCall),
    });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalled());
    expect(executor.cancel(firstCall.requestId, firstCall.callId)).toBe(true);
    rejectWrite(new Error('write rejected'));
    await vi.advanceTimersByTimeAsync(AGENT_TERMINAL_INTERRUPT_GRACE_MS);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });

    const resumedCall = {
      ...toolCall('uptime'),
      requestId: 'request-2',
      callId: 'call-2',
    };
    await expect(executor.execute({
      toolCall: resumedCall,
      authorization: authorization(resumedCall),
    })).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('has not confirmed termination'),
    });
  });

  it('fails cleanly when the frozen session disconnects', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalled());
    terminalEvents.emitClosed('session-1');
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.output).toContain('session closed before command completion');
  });

  it('fails when the bound terminal is closed or rebound instead of drifting to a replacement', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const firstCall = toolCall('sleep 60');
    const firstExecutor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const closing = firstExecutor.execute({
      toolCall: firstCall,
      authorization: authorization(firstCall),
    });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalled());
    terminalRegistry.dispose('session-1');
    expect((await closing).status).toBe('failed');

    await createRemoteController();
    vi.mocked(invokeWriteSession).mockClear();
    const secondCall = toolCall('sleep 60');
    const secondExecutor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const rebinding = secondExecutor.execute({
      toolCall: secondCall,
      authorization: authorization(secondCall),
    });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalled());
    terminalRegistry.rebindSession('session-1', 'replacement-session');
    expect((await rebinding).status).toBe('failed');
    expect(invokeWriteSession).not.toHaveBeenCalledWith('replacement-session', expect.anything());
  });

  it('continues targeting the frozen session after the active tab changes', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    useTerminalStore.getState().addSession({
      sessionId: 'session-2',
      title: 'other',
      host: 'other.example.com',
      port: 22,
      username: 'other',
    }, 'profile-2');
    useTerminalStore.getState().setActiveSession('session-2');
    const call = toolCall('pwd');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementation(async (sessionId, data) => {
      terminalEvents.emitData(sessionId, data);
      if (!data.endsWith('\r')) return;
      terminalEvents.emitData(sessionId, `${testFrames(boundary).beginToken}\r\n/srv/app\r\n${testFrames(boundary).endPrefix}0\u0007`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('completed');
    expect(invokeWriteSession).toHaveBeenCalledWith('session-1', expect.any(String));
    expect(invokeWriteSession).not.toHaveBeenCalledWith('session-2', expect.any(String));
  });

  it('rejects authorization, target identity, command controls, length, and interactive programs before PTY input', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const cases = [
      (() => {
        const call = toolCall('pwd');
        return { toolCall: call, authorization: { ...authorization(call), callId: 'wrong-call' } };
      })(),
      (() => {
        const call = toolCall('pwd', { ...remoteTarget(), host: 'changed.example.com' });
        return { toolCall: call, authorization: authorization(call) };
      })(),
      ...['echo one\necho two', 'echo one\recho two', 'echo one\0echo two',
        'echo one\u001becho two', 'echo one\u2028echo two', 'echo one\u2029echo two']
        .map((command) => {
          const call = toolCall(command);
          return { toolCall: call, authorization: authorization(call) };
        }),
      (() => {
        const call = toolCall('x'.repeat(AGENT_TERMINAL_COMMAND_LIMIT_CHARS + 1));
        return { toolCall: call, authorization: authorization(call) };
      })(),
      (() => {
        const call = toolCall('ssh nested.example.com');
        return { toolCall: call, authorization: authorization(call) };
      })(),
      (() => {
        const call = toolCall("python3 -c 'input()'");
        return { toolCall: call, authorization: authorization(call) };
      })(),
    ];

    for (const input of cases) {
      const result = await executor.execute(input);
      expect(result.status).toBe('failed');
    }
    expect(invokeWriteSession).not.toHaveBeenCalled();
  });

  it('validates the frozen target against the exact controller and profile identity', () => {
    const session = useTerminalStore.getState().sessions[0];
    const controller = terminalRegistry.get('session-1');
    expect(validateFrozenAgentTarget(remoteTarget(), session, controller)).toBeNull();
    expect(validateFrozenAgentTarget(
      { ...remoteTarget(), profileId: 'different-profile' },
      session,
      controller,
    )).toContain('identity');
  });
});

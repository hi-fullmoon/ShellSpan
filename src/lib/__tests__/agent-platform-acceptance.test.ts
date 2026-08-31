/// <reference types="node" />

import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentTerminalBoundaryParser,
  buildAgentTerminalWrapper,
  createAgentTerminalBoundary,
  createAgentTerminalInputChunks,
} from '../agent-terminal-executor';

const NONCE = '89abcdef01234567'.repeat(3);
const REAL_SHELL_IDLE_TIMEOUT_MS = 10_000;
const REAL_SHELL_HARD_TIMEOUT_MS = 30_000;
const REAL_SHELL_TEST_TIMEOUT_MS = 35_000;
const REAL_SHELL_INPUT_DELAY_MS = 100;
const WINDOWS_OWNER_DEATH_CLEANUP_TIMEOUT_MS = 5_000;
const POWERSHELL_STDIN_SCRIPT_END = '__SHELLSPAN_ACCEPTANCE_SCRIPT_END_89abcdef__';

interface ShellDeadlines {
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
}

type ShellDeadlineKind = 'idle' | 'hard';

interface ShellDeadlineController {
  readonly progress: (phase: string) => void;
  readonly dispose: () => void;
}

function createShellDeadlineController(
  deadlines: ShellDeadlines,
  onTimeout: (kind: ShellDeadlineKind, lastProgress: string) => void,
): ShellDeadlineController {
  let disposed = false;
  let lastProgress = 'spawn requested';
  let idleTimer: ReturnType<typeof setTimeout>;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  };
  const expire = (kind: ShellDeadlineKind): void => {
    if (disposed) return;
    const phase = lastProgress;
    dispose();
    onTimeout(kind, phase);
  };
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire('idle'), deadlines.idleTimeoutMs);
  };
  const progress = (phase: string): void => {
    if (disposed) return;
    lastProgress = phase;
    armIdleTimer();
  };
  const hardTimer = setTimeout(
    () => expire('hard'),
    deadlines.hardTimeoutMs,
  );
  armIdleTimer();

  return { progress, dispose };
}

interface ShellRun {
  readonly exitCode: number | null;
  readonly output: string;
  readonly parsedExitCode?: number;
  readonly captured: string;
}

function runShell(
  executable: string,
  args: readonly string[],
  input: string | readonly string[],
  parser: AgentTerminalBoundaryParser,
  deadlines: ShellDeadlines = {
    idleTimeoutMs: REAL_SHELL_IDLE_TIMEOUT_MS,
    hardTimeoutMs: REAL_SHELL_HARD_TIMEOUT_MS,
  },
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { ...process.env, PAGER: 'original-pager' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    let output = '';
    let parsedExitCode: number | undefined;
    const cleanup = (): void => {
      deadline.dispose();
      if (inputTimer !== undefined) clearTimeout(inputTimer);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(error);
    };
    const deadline = createShellDeadlineController(
      deadlines,
      (kind, lastProgress) => {
        const message = kind === 'idle'
          ? `real shell acceptance made no progress for ${deadlines.idleTimeoutMs}ms after ${lastProgress}: ${executable}`
          : `real shell acceptance exceeded ${deadlines.hardTimeoutMs}ms hard deadline after ${lastProgress}: ${executable}`;
        fail(new Error(message));
      },
    );
    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      const text = chunk.toString('utf8');
      output += text;
      parsedExitCode ??= parser.push(text)?.exitCode;
      deadline.progress(`${stream} output`);
    };
    child.stdout.on('data', (chunk: Buffer) => onChunk('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => onChunk('stderr', chunk));
    child.once('error', fail);
    child.stdin.once('error', fail);
    child.once('spawn', () => {
      deadline.progress('process spawned');
      const submitInput = (): void => {
        if (settled) return;
        if (typeof input === 'string') {
          child.stdin.end(input, () => {
            if (!settled) deadline.progress('stdin submitted');
          });
          return;
        }
        let index = 0;
        const submitChunk = (): void => {
          if (settled) return;
          const isLast = index === input.length - 1;
          const onSubmitted = (): void => {
            if (settled) return;
            deadline.progress(`stdin chunk ${index + 1}/${input.length} submitted`);
            index += 1;
            if (!isLast) inputTimer = setTimeout(submitChunk, 25);
          };
          if (isLast) child.stdin.end(input[index], onSubmitted);
          else child.stdin.write(input[index], onSubmitted);
        };
        submitChunk();
      };
      inputTimer = setTimeout(submitInput, REAL_SHELL_INPUT_DELAY_MS);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        output,
        parsedExitCode,
        captured: parser.finishCapture().text,
      });
    });
  });
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function nativePtyShellCommand(): string {
  return process.platform === 'darwin'
    ? '/bin/cat | /usr/bin/script -q /dev/null /bin/zsh -f'
    : "/bin/cat | /usr/bin/script -q -c '/bin/sh' /dev/null";
}

function powerShellStdinScriptArguments(): readonly string[] {
  // `powershell.exe -Command -` executes redirected stdin one physical line at
  // a time and silently discards a statement continued with a trailing
  // backtick. The production terminal is a ConPTY and parses those continued
  // lines interactively. This native-shell harness reconstructs the exact
  // chunked statement before parsing it so the real supervisor, Job Object,
  // completion capability, and cleanup paths still execute under PowerShell.
  const bootstrap = [
    '$__shellspanAcceptanceSource=[System.Text.StringBuilder]::new()',
    `while ($true) { $__shellspanAcceptanceLine=[Console]::In.ReadLine(); if ($null -eq $__shellspanAcceptanceLine) { exit 125 }; if ($__shellspanAcceptanceLine -ceq '${POWERSHELL_STDIN_SCRIPT_END}') { break }; [void]$__shellspanAcceptanceSource.Append($__shellspanAcceptanceLine); [void]$__shellspanAcceptanceSource.Append("\`n") }`,
    '& ([ScriptBlock]::Create($__shellspanAcceptanceSource.ToString()))',
  ].join(';');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap];
}

function createPowerShellStdinScriptChunks(wrapper: string): readonly string[] {
  return [
    ...createAgentTerminalInputChunks(wrapper, 'powershell'),
    // Keep the pipe open in the owner-death case. StreamReader waits after a
    // lone CR to determine whether it begins CRLF, unlike an interactive PTY.
    `${POWERSHELL_STDIN_SCRIPT_END}\r\n`,
  ];
}

describe('Agent M6 real platform shell acceptance', () => {
  it('refreshes the idle deadline on progress', () => {
    vi.useFakeTimers();
    try {
      const expired: ShellDeadlineKind[] = [];
      const deadline = createShellDeadlineController(
        { idleTimeoutMs: 100, hardTimeoutMs: 1_000 },
        (kind) => expired.push(kind),
      );

      vi.advanceTimersByTime(90);
      deadline.progress('process spawned');
      vi.advanceTimersByTime(90);
      deadline.progress('stdout output');
      vi.advanceTimersByTime(99);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toEqual(['idle']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let progress extend the hard deadline', () => {
    vi.useFakeTimers();
    try {
      const expired: ShellDeadlineKind[] = [];
      const deadline = createShellDeadlineController(
        { idleTimeoutMs: 100, hardTimeoutMs: 250 },
        (kind) => expired.push(kind),
      );

      vi.advanceTimersByTime(90);
      deadline.progress('process spawned');
      vi.advanceTimersByTime(90);
      deadline.progress('stdout output');
      vi.advanceTimersByTime(69);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toEqual(['hard']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform === 'darwin')(
    'executes and parses the production POSIX wrapper with the native macOS shell',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "printf '\\033[32mmacos-real-pty\\033[0m\\n'; printf 'password=\"quoted secret value\"\\n'; false",
        boundary,
        'posix',
      );
      const result = await runShell(
        '/bin/zsh',
        ['-f'],
        `${wrapper}\nexit\n`,
        parser,
      );

      expect(result.exitCode).not.toBeNull();
      expect(result.parsedExitCode, result.output).toBe(1);
      expect(result.captured).toContain('macos-real-pty');
      expect(result.captured).toContain('quoted secret value');
      expect(result.output.split(boundary.beginPrefix)).toHaveLength(2);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'darwin')(
    'submits the chunked production wrapper through a native macOS PTY',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const payload = 'x'.repeat(512);
      const wrapper = buildAgentTerminalWrapper(
        `printf 'macos-real-terminal-%s\\n' '${payload}'; false`,
        boundary,
        'posix',
      );
      const result = await runShell(
        '/bin/sh',
        ['-c', '/bin/cat | /usr/bin/script -q /dev/null /bin/zsh -f'],
        `${wrapper}\rexit\r`,
        parser,
      );

      expect(result.parsedExitCode, result.output).toBe(1);
      expect(result.captured).toContain('macos-real-terminal');
      expect(result.captured).toContain(payload);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'darwin')(
    'submits the production wrapper through the native macOS Bash PTY',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "printf 'macos-bash-pty\\n'; false",
        boundary,
        'posix',
      );
      const result = await runShell(
        '/bin/sh',
        ['-c', '/bin/cat | /usr/bin/script -q /dev/null /bin/bash --noprofile --norc'],
        [...createAgentTerminalInputChunks(wrapper, 'posix'), 'exit\r'],
        parser,
      );

      expect(result.parsedExitCode, result.output).toBe(1);
      expect(result.captured).toContain('macos-bash-pty');
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== 'win32')(
    'contains POSIX completion state despite inherited auto-export and errexit options',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const attack = [
        "for __tb_candidate in $(set | /usr/bin/sed -n 's/^\\(__tb_marker_[A-Za-z0-9_]*\\)=.*/\\1/p'); do eval \"__tb_leaked_marker=\\$$__tb_candidate\"; done",
        "for __tb_candidate in $(set | /usr/bin/sed -n 's/^\\(__tb_capability_[A-Za-z0-9_]*\\)=.*/\\1/p'); do eval \"__tb_leaked_capability=\\$$__tb_candidate\"; done",
        "printf '\\036%s:END:%s:0\\037' \"$__tb_leaked_marker\" \"$__tb_leaked_capability\"",
        "printf 'after-forgery'",
        'false',
      ].join('; ');
      const wrapper = buildAgentTerminalWrapper(
        attack,
        boundary,
        'posix',
      );
      const result = await runShell(
        '/usr/bin/env',
        [
          'SHELLOPTS=xtrace',
          'PS4=TRACE:${__tb_k-}:',
          'PERL5OPT=-MDefinitelyMissingShellspanModule',
          '/bin/sh',
        ],
        `set -a; set -e\n${wrapper}\nexit\n`,
        parser,
      );

      expect(result.parsedExitCode, result.output).toBe(1);
      expect(result.captured).toContain('after-forgery');
      expect(result.captured).not.toContain(boundary.marker);
      expect(result.captured).not.toContain(boundary.endPrefix);
      const capability = new RegExp(`${boundary.endPrefix}([a-f0-9]{48}):`, 'i')
        .exec(result.output)?.[1];
      expect(capability).toMatch(/^[a-f0-9]{48}$/i);
      expect(result.captured).not.toContain(capability);
      expect(result.output.slice(0, result.output.indexOf(boundary.beginPrefix)))
        .not.toContain(capability);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== 'win32')(
    'unsets inherited loader trace controls before starting the POSIX supervisor',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "printf 'loader-trace-cleared'",
        boundary,
        'posix',
      );
      const result = await runShell(
        '/bin/sh',
        [],
        `export LD_TRACE_LOADED_OBJECTS=1\n${wrapper}\nexit\n`,
        parser,
      );

      expect(result.parsedExitCode, result.output).toBe(0);
      expect(result.captured).toContain('loader-trace-cleared');
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== 'win32')(
    'terminates descendants in the command process group before authenticating completion',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "sleep 3 & printf 'posix-descendant:%s\\n' \"$!\"",
        boundary,
        'posix',
      );
      const startedAt = Date.now();
      const result = await runShell(
        '/bin/sh',
        ['-c', nativePtyShellCommand()],
        `${wrapper}\rexit\r`,
        parser,
      );
      const descendantMatch = /posix-descendant:(\d+)/.exec(result.captured);

      expect(result.parsedExitCode, result.output).toBe(0);
      expect(descendantMatch).not.toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(processExists(Number(descendantMatch![1]))).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== 'win32')(
    'uses only fixed system directories for an auto-approved POSIX command',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        'printf %s "$PATH"',
        boundary,
        'posix',
        true,
      );
      const result = await runShell('/bin/sh', [], `${wrapper}\nexit\n`, parser);

      expect(result.parsedExitCode, result.output).toBe(0);
      expect(result.captured).toContain('/usr/bin:/bin:/usr/sbin:/sbin');
      expect(result.captured).not.toContain('/usr/local');
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== 'win32')(
    'emits an authenticated cancellation frame after the foreground group receives SIGINT',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "printf 'posix-cancel-started:%s\\n' \"$$\"; sleep 60",
        boundary,
        'posix',
      );
      let commandGroupId: number | undefined;
      const result = await new Promise<ShellRun>((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', wrapper], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let parsedExitCode: number | undefined;
        let interrupted = false;
        const timeout = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // The process group may already have exited while the timer fired.
          }
          if (commandGroupId !== undefined) {
            try {
              process.kill(-commandGroupId, 'SIGKILL');
            } catch {
              // The supervised command group may already have exited.
            }
          }
          reject(new Error(`POSIX cancellation acceptance exceeded its hard deadline: ${output}`));
        }, REAL_SHELL_IDLE_TIMEOUT_MS);
        const onChunk = (chunk: Buffer): void => {
          const text = chunk.toString('utf8');
          output += text;
          parsedExitCode ??= parser.push(text)?.exitCode;
          const commandGroupMatch = /posix-cancel-started:(\d+)/.exec(output);
          commandGroupId ??= commandGroupMatch ? Number(commandGroupMatch[1]) : undefined;
          if (!interrupted && commandGroupId !== undefined) {
            interrupted = true;
            process.kill(-child.pid!, 'SIGINT');
          }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (exitCode) => {
          clearTimeout(timeout);
          resolve({
            exitCode,
            output,
            parsedExitCode,
            captured: parser.finishCapture().text,
          });
        });
      });

      expect(result.parsedExitCode, result.output).toBe(130);
      expect(result.captured).toContain('posix-cancel-started');
      expect(result.output).not.toContain('Secure completion capability generation failed.');
      expect(commandGroupId).toBeDefined();
      expect(() => process.kill(-commandGroupId!, 0)).toThrow();
    },
    15_000,
  );

  it.runIf(process.platform !== 'win32').each([
    ['Ctrl-C', '\u0003'],
    ['Ctrl-Z', '\u001a'],
  ] as const)(
    'handles a real %s byte through the native PTY before authenticating cancellation',
    async (_controlName, controlByte) => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "printf 'native-pty-cancel:%s\\n' \"$$\"; sleep 60",
        boundary,
        'posix',
      );
      let commandGroupId: number | undefined;
      const result = await new Promise<ShellRun>((resolve, reject) => {
        const child = spawn(
          '/bin/sh',
          ['-c', nativePtyShellCommand()],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let output = '';
        let parsedExitCode: number | undefined;
        let interrupted = false;
        let exiting = false;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          if (commandGroupId !== undefined) {
            try {
              process.kill(-commandGroupId, 'SIGKILL');
            } catch {
              // The wrapper may have already reaped the foreground group.
            }
          }
          reject(new Error(`native PTY cancellation exceeded its hard deadline: ${output}`));
        }, REAL_SHELL_IDLE_TIMEOUT_MS);
        const onChunk = (chunk: Buffer): void => {
          const text = chunk.toString('utf8');
          output += text;
          parsedExitCode ??= parser.push(text)?.exitCode;
          const commandGroupMatch = /native-pty-cancel:(\d+)/.exec(output);
          commandGroupId ??= commandGroupMatch ? Number(commandGroupMatch[1]) : undefined;
          if (!interrupted && commandGroupId !== undefined) {
            interrupted = true;
            child.stdin.write(controlByte);
          }
          if (!exiting && parsedExitCode !== undefined) {
            exiting = true;
            child.stdin.end('exit\r');
          }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('spawn', () => {
          setTimeout(() => child.stdin.write(`${wrapper}\r`), REAL_SHELL_INPUT_DELAY_MS);
        });
        child.once('close', (exitCode) => {
          clearTimeout(timeout);
          resolve({
            exitCode,
            output,
            parsedExitCode,
            captured: parser.finishCapture().text,
          });
        });
      });

      expect(result.parsedExitCode, result.output).toBe(130);
      expect(result.captured).toContain('native-pty-cancel');
      expect(commandGroupId).toBeDefined();
      expect(() => process.kill(-commandGroupId!, 0)).toThrow();
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'executes and parses the production PowerShell wrapper with the native Windows shell',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        "Write-Output 'windows-real-shell'; Write-Output 'password=\"quoted secret value\"'; & cmd /c exit 7",
        boundary,
        'powershell',
      );
      const result = await runShell(
        'powershell.exe',
        powerShellStdinScriptArguments(),
        createPowerShellStdinScriptChunks(wrapper),
        parser,
      );

      expect(result.exitCode).not.toBeNull();
      expect(result.parsedExitCode, result.output).toBe(7);
      expect(result.captured).toContain('windows-real-shell');
      expect(result.captured).toContain('quoted secret value');
      expect(result.output.split(boundary.beginPrefix)).toHaveLength(2);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'win32')(
    'waits for the Windows Job Object to terminate descendants before authenticating completion',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const parser = new AgentTerminalBoundaryParser(boundary);
      const wrapper = buildAgentTerminalWrapper(
        [
          "$child=Start-Process -FilePath $env:ComSpec -ArgumentList '/c','ping -n 60 127.0.0.1 >nul' -PassThru",
          "Write-Output ('windows-descendant:'+$child.Id)",
        ].join('; '),
        boundary,
        'powershell',
      );
      const result = await runShell(
        'powershell.exe',
        powerShellStdinScriptArguments(),
        createPowerShellStdinScriptChunks(wrapper),
        parser,
      );
      const descendantMatch = /windows-descendant:(\d+)/.exec(result.captured);

      expect(result.parsedExitCode, result.output).toBe(0);
      expect(descendantMatch).not.toBeNull();
      expect(processExists(Number(descendantMatch![1]))).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'win32')(
    'terminates the Windows Job when the owning shell is killed',
    async () => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const wrapper = buildAgentTerminalWrapper(
        [
          "$child=Start-Process -FilePath $env:ComSpec -ArgumentList '/c','ping -n 60 127.0.0.1 >nul' -PassThru",
          "Write-Output ('windows-owner-descendant:'+$child.Id)",
          'Start-Sleep -Seconds 60',
        ].join('; '),
        boundary,
        'powershell',
      );

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          powerShellStdinScriptArguments(),
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let output = '';
        let descendantId: number | undefined;
        let settled = false;
        let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimeout);
          if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout);
          clearInterval(deathPoll);
          if (!child.killed) child.kill();
          if (error) reject(error);
          else resolve();
        };
        const hardTimeout = setTimeout(() => {
          if (descendantId !== undefined && processExists(descendantId)) {
            try { process.kill(descendantId, 'SIGKILL'); } catch { /* already exited */ }
          }
          finish(new Error(`Windows owner-death acceptance exceeded its hard deadline: ${output}`));
        }, REAL_SHELL_HARD_TIMEOUT_MS);
        const deathPoll = setInterval(() => {
          if (descendantId !== undefined && !processExists(descendantId)) finish();
        }, 25);
        const onChunk = (chunk: Buffer): void => {
          output += chunk.toString('utf8');
          const match = /windows-owner-descendant:(\d+)/.exec(output);
          if (descendantId === undefined && match) {
            descendantId = Number(match[1]);
            child.kill();
            cleanupTimeout = setTimeout(() => {
              if (descendantId !== undefined && processExists(descendantId)) {
                try { process.kill(descendantId, 'SIGKILL'); } catch { /* already exited */ }
              }
              finish(new Error(`Windows owner-death cleanup exceeded its deadline: ${output}`));
            }, WINDOWS_OWNER_DEATH_CLEANUP_TIMEOUT_MS);
          }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.stdin.on('error', (error) => {
          if (!child.killed) finish(error);
        });
        child.once('error', finish);
        child.once('spawn', () => {
          const chunks = createPowerShellStdinScriptChunks(wrapper);
          let index = 0;
          const submit = (): void => {
            if (settled || child.killed || index >= chunks.length) return;
            child.stdin.write(chunks[index], () => {
              index += 1;
              setTimeout(submit, 25);
            });
          };
          submit();
        });
      });
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );
});

/// <reference types="node" />

import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentTerminalBoundaryParser,
  buildAgentTerminalWrapper,
  createAgentTerminalBoundary,
} from '../agent-terminal-executor';

const NONCE = '89abcdef01234567'.repeat(3);
const REAL_SHELL_IDLE_TIMEOUT_MS = 10_000;
const REAL_SHELL_HARD_TIMEOUT_MS = 30_000;
const REAL_SHELL_TEST_TIMEOUT_MS = 35_000;
const REAL_SHELL_INPUT_DELAY_MS = 100;

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
  input: string,
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
      // Keep the macOS line-discipline allowance, but end stdin only after
      // Node confirms that it accepted the complete wrapper write.
      inputTimer = setTimeout(() => {
        if (settled) return;
        child.stdin.end(input, () => {
          if (!settled) deadline.progress('stdin submitted');
        });
      }, REAL_SHELL_INPUT_DELAY_MS);
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
        `${wrapper}\rexit\r`,
        parser,
      );

      expect(result.exitCode).not.toBeNull();
      expect(result.parsedExitCode).toBe(1);
      expect(result.captured).toContain('macos-real-pty');
      expect(result.captured).toContain('quoted secret value');
      expect(result.output.split(boundary.beginToken)).toHaveLength(2);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
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
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
        `${wrapper}\r\nexit\r\n`,
        parser,
      );

      expect(result.exitCode).not.toBeNull();
      expect(result.parsedExitCode).toBe(7);
      expect(result.captured).toContain('windows-real-shell');
      expect(result.captured).toContain('quoted secret value');
      expect(result.output.split(boundary.beginToken)).toHaveLength(2);
    },
    REAL_SHELL_TEST_TIMEOUT_MS,
  );
});

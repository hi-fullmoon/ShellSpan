/// <reference types="node" />

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AgentTerminalBoundaryParser,
  buildAgentTerminalWrapper,
  createAgentTerminalBoundary,
} from '../agent-terminal-executor';

const NONCE = '89abcdef01234567'.repeat(3);

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
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { ...process.env, PAGER: 'original-pager' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let parsedExitCode: number | undefined;
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output += text;
      parsedExitCode ??= parser.push(text)?.exitCode;
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`real shell acceptance timed out: ${executable}`));
    }, 10_000);
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        output,
        parsedExitCode,
        captured: parser.finishCapture().text,
      });
    });
    // A real PTY shell can still be completing line-discipline/startup setup
    // when the parent process is spawned. Sending EOF in the same tick can
    // make macOS `script` echo but discard the first command line.
    setTimeout(() => {
      child.stdin.write(input);
      setTimeout(() => child.stdin.end(), 50);
    }, 100);
  });
}

describe('Agent M6 real platform shell acceptance', () => {
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
    15_000,
  );
});

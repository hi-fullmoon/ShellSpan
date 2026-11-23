import { cleanup, render, screen } from '@testing-library/react';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiToolExpandedContent, toolOutputForCopy } from '@/components/ai/workspace/ai-tool-presentation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { stripAnsi } from '@/lib/terminal/terminal-output-buffer';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import zshCapture from './fixtures/zsh-terminal-result.json';

function execute(script: string) {
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return {
    command: `${process.execPath} -e ${JSON.stringify(script)}`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function terminalNode(command: string, output: unknown): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool', key: command, sourceKind: 'agent', sessionId: 'terminal-result',
    turnId: command, stepId: command, callId: command, firstSeq: 1, lastSeq: 2,
    timestamp: new Date().toISOString(), name: 'run_terminal_command', nativeName: 'terminal_execute',
    title: null, summary: command, state: 'succeeded', effect: 'readOnly', durationMs: null,
    evidenceRefs: [], detailRef: { kind: 'agentTool', sessionId: 'terminal-result', callId: command },
    input: { command }, output, error: null,
    target: null, idempotency: null, approval: null,
  };
}

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('terminal result presentation', () => {
  it.each(['zh-CN', 'en-US'] as const)('shows a real combined capture and keeps execution metadata in details in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const result = execute('console.log(process.cwd()); console.log(process.version)');
    const metadata = { commandLine: result.command, cwd: process.cwd(), exitCode: result.exitCode, execution: 'completed' };
    const node = terminalNode(result.command, { ...metadata, stdout: '', stderr: '', combinedOutput: result.stdout });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect([...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')].map(line => line.textContent).join('\n')).toBe(result.stdout.trimEnd());
    expect(container.querySelector('[data-ai-terminal-output]')).not.toHaveTextContent('commandLine');
    expect(container.querySelector('.ai-terminal-footer')).toHaveTextContent(locale === 'zh-CN' ? /^成功$/u : /^Succeeded$/u);
    expect(container.querySelector('.ai-terminal-footer svg')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-header')).toHaveTextContent(/^Shell$/u);
    expect(container.querySelector('[data-ai-terminal-execution]')).not.toHaveClass('ai-terminal-exit');
    expect(toolOutputForCopy(node)).toBe(result.stdout);
  });

  it.each(['combined', 'separate'] as const)('keeps an empty %s capture empty instead of displaying its envelope', format => {
    const result = execute('process.exit(0)');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    const output = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
      ...(format === 'combined' ? { combinedOutput: result.stdout } : {}) };
    const node = terminalNode(result.command, output);
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(screen.getByText('No output')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-footer')).toHaveTextContent(/^Succeeded$/u);
    expect(container.querySelector('[data-ai-terminal-output]')).not.toHaveTextContent('exitCode');
    expect(toolOutputForCopy(node)).toBe('');
  });

  it('keeps a shared capture authoritative even when separate streams are also supplied', () => {
    const result = execute('console.log(process.cwd()); console.error(process.version)');
    const artifacts = join(process.cwd(), 'artifacts/tests/terminal-result-presentation');
    mkdirSync(artifacts, { recursive: true });
    const capture = join(mkdtempSync(join(artifacts, 'combined-')), 'output.txt');
    const fd = openSync(capture, 'wx');
    try {
      const combined = spawnSync(process.execPath, ['-e', 'console.log(process.cwd()); console.error(process.version)'], { stdio: ['ignore', fd, fd] });
      expect(combined.error).toBeUndefined();
      expect(combined.status).toBe(0);
    } finally {
      closeSync(fd);
    }
    const combinedOutput = readFileSync(capture, 'utf8');
    const node = terminalNode(result.command, { ...result, combinedOutput });
    expect(toolOutputForCopy(node)).toBe(combinedOutput);
    expect(toolOutputForCopy(node).split(process.version)).toHaveLength(2);
  });

  it('joins real separate streams without adding another newline', () => {
    const result = execute('console.log(process.cwd()); console.error(process.version)');
    const node = terminalNode(result.command, result);
    expect(toolOutputForCopy(node)).toBe(result.stdout + result.stderr);
  });

  it('keeps legacy output text when the separate streams are empty', () => {
    const result = execute('console.log(process.cwd())');
    const empty = execute('process.exit(0)');
    const node = terminalNode(result.command, { output: result.stdout, stdout: empty.stdout, stderr: empty.stderr });
    expect(toolOutputForCopy(node)).toBe(result.stdout);
  });

  it.each(['combined', 'separate', 'legacy'] as const)('displays and copies %s output without ANSI sequences', format => {
    const result = execute(`
      const { clearLine } = require('node:readline');
      const { styleText } = require('node:util');
      clearLine(process.stdout, 1);
      const name = styleText(['bold', 'red'], process.release.name, { validateStream: false });
      process.stdout.write(name + '  版本 ' + process.version + '\\r\\n');
      process.stderr.write(styleText('yellow', process.platform, { validateStream: false }) + '\\n');
    `);
    expect(result.stdout).toContain('\u001b[0K');
    expect(result.stdout).toContain('\u001b[31m');
    expect(result.stderr).toContain('\u001b[33m');

    const combined = result.stdout + result.stderr;
    const output = format === 'combined' ? { combinedOutput: combined }
      : format === 'separate' ? { stdout: result.stdout, stderr: result.stderr } : combined;
    const node = terminalNode(result.command, output);
    const { container } = render(<AiToolExpandedContent node={node} />);
    const outputLines = () => [...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')]
      .map(line => line.textContent);

    const stdoutLine = `${process.release.name}  版本 ${process.version}`;
    expect(outputLines()).toEqual([stdoutLine, process.platform]);
    expect(toolOutputForCopy(node)).toBe(`${stdoutLine}\r\n${process.platform}\n`);
  });

  it('shows the exited job status instead of the successful launch status', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    const node = terminalNode(`${process.execPath} -e 'process.exit(7)'`, {
      execution: 'completed', exitCode: 0, combinedOutput: result.stdout + result.stderr,
      job: { state: 'exited', exitCode: result.status },
    });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(container.querySelector('.ai-terminal-footer')).toHaveTextContent(/^Exit 7$/u);
    expect(container.querySelector('.ai-terminal-footer svg')).not.toBeInTheDocument();
  });

  it('preserves whitespace in an actual terminal capture', () => {
    const result = execute('process.stdout.write(" \\t\\n")');
    const node = terminalNode(result.command, { combinedOutput: result.stdout, exitCode: result.exitCode });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(container.querySelector('.ai-block-line')?.textContent).toBe(result.stdout.slice(0, -1));
    expect(toolOutputForCopy(node)).toBe(result.stdout);
    expect(screen.queryByText('No output')).toBeNull();
  });

  it('omits nonprinting controls from displayed and copied command output', () => {
    const result = execute(
      "process.stdout.write('文件\\t路径 □\\r\\n'); process.stderr.write('!\\x07' + process.platform + '\\n\\x18');",
    );
    const node = terminalNode(result.command, { combinedOutput: result.stdout + result.stderr });
    const { container } = render(<AiToolExpandedContent node={node} />);

    expect([...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')]
      .map(line => line.textContent)).toEqual(['文件\t路径 □', '!' + process.platform]);
    expect(toolOutputForCopy(node)).toBe('文件\t路径 □\r\n!' + process.platform + '\n');
  });

  it.each([
    [zshCapture.withNewline, '100%\r\n%\r\n', ['100%', '%']],
    [zshCapture.withoutNewline, '%', ['%']],
    [zshCapture.empty, '', []],
  ] as const)('keeps only the command text in a recorded zsh PTY capture (%#)', ({ command, output }, expected, lines) => {
    const node = terminalNode(command, { combinedOutput: output, exitCode: 0 });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect([...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')].map(line => line.textContent)).toEqual(lines);
    expect(toolOutputForCopy(node)).toBe(expected);
    if (!expected) expect(screen.getByText('No output')).toBeInTheDocument();
  });

  it('applies carriage-return overwrites even when the capture has already lost its ANSI styling', () => {
    const { command, output } = zshCapture.withNewline;
    const node = terminalNode(command, { combinedOutput: stripAnsi(output) });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect([...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')].map(line => line.textContent)).toEqual(['100%', '%']);
    expect(toolOutputForCopy(node)).toBe('100%\r\n%\r\n');
  });

  it('shows and copies the final state of a command that redraws a progress line', () => {
    const result = execute('process.stdout.write("Progress 10%\\rProgress 100%\\n")');
    const node = terminalNode(result.command, result);
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(container.querySelector('[data-ai-terminal-output] .ai-block-line')?.textContent).toBe('Progress 100%');
    expect(toolOutputForCopy(node)).toBe('Progress 100%\n');
  });

  it('distinguishes a successful launch from a process that is still running', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await once(child, 'spawn');
      expect(child.exitCode).toBeNull();
      const node = terminalNode(`${process.execPath} -e 'process.stdin.resume()'`, {
        execution: child.exitCode === null ? 'running' : 'completed',
        exitCode: 0, combinedOutput: '', stdout: '', stderr: '',
      });
      const { container } = render(<AiToolExpandedContent node={node} />);
      const footer = container.querySelector('.ai-terminal-footer');
      expect(footer?.querySelector('[data-ai-terminal-execution="running"]')).toHaveTextContent('Process running');
      expect(footer?.querySelector('svg')).not.toBeInTheDocument();
      expect(footer).not.toHaveTextContent(/Process exited|Exit 0/u);
    } finally {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  });
});

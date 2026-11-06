import { cleanup, render, screen } from '@testing-library/react';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiToolDetails } from '@/components/ai/workspace/ai-tool-details';
import { AiToolExpandedContent, toolOutputForCopy } from '@/components/ai/workspace/ai-tool-presentation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

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
    const { container, rerender } = render(<AiToolExpandedContent node={node} />);
    expect([...container.querySelectorAll('[data-ai-terminal-output] .ai-block-line')].map(line => line.textContent).join('\n')).toBe(result.stdout.trimEnd());
    expect(container.querySelector('[data-ai-terminal-output]')).not.toHaveTextContent('commandLine');
    expect(container.querySelector('[data-ai-terminal-execution]')).toHaveTextContent(locale === 'zh-CN' ? '进程已退出' : 'Process exited');
    expect(container.querySelector('[data-ai-terminal-execution]')).not.toHaveClass('ai-terminal-exit');
    expect(toolOutputForCopy(node)).toBe(result.stdout);

    rerender(<AiToolDetails node={node} onBack={() => undefined} />);
    const sections = container.querySelectorAll('.ai-detail-section');
    expect(sections[1]).not.toHaveTextContent('commandLine');
    expect(sections[2].querySelector('h3')).toHaveTextContent(locale === 'zh-CN' ? '执行信息' : 'Execution details');
    expect(sections[2].querySelector('code')?.textContent).toBe(JSON.stringify(metadata, null, 2));
    expect(sections[2].querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'max-h-65');
    expect(sections[2].querySelector('[data-slot="scroll-area-content"]')).toHaveStyle({ minWidth: '0' });
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
    expect(container.querySelector('[data-ai-terminal-output]')).not.toHaveTextContent('exitCode');
    expect(toolOutputForCopy(node)).toBe('');
  });

  it('keeps a shared capture authoritative even when separate streams are also supplied', () => {
    const result = execute('console.log(process.cwd()); console.error(process.version)');
    const artifacts = join(process.cwd(), '.artifacts/tests/terminal-result-presentation');
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

  it('shows the exited job status instead of the successful launch status', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    const node = terminalNode(`${process.execPath} -e 'process.exit(7)'`, {
      execution: 'completed', exitCode: 0, combinedOutput: result.stdout + result.stderr,
      job: { state: 'exited', exitCode: result.status },
    });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(container.querySelector('.ai-terminal-header')).toHaveTextContent('Exit 7');
  });

  it('preserves whitespace in an actual terminal capture', () => {
    const result = execute('process.stdout.write(" \\t\\n")');
    const node = terminalNode(result.command, { combinedOutput: result.stdout, exitCode: result.exitCode });
    const { container } = render(<AiToolExpandedContent node={node} />);
    expect(container.querySelector('.ai-block-line')?.textContent).toBe(result.stdout.slice(0, -1));
    expect(toolOutputForCopy(node)).toBe(result.stdout);
    expect(screen.queryByText('No output')).toBeNull();
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
      expect(container.querySelector('[data-ai-terminal-execution="running"]')).toHaveTextContent('Process running');
      expect(container.querySelector('.ai-terminal-header')).not.toHaveTextContent('Process exited');
      expect(container.querySelector('.ai-terminal-header')).not.toHaveTextContent('Exit 0');
    } finally {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  });
});

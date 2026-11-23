import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

import { AiToolExpandedContent, AiToolRow, classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import skillsCapture from '@/tests/fixtures/agent-skills-runtime.json';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import readRecoveryCapture from '@/tests/fixtures/tool-result-read-recovery.json';
import { conversationFoldRecording } from '@/tests/fixtures/conversation-fold-runtime';

function capturedRead(recovered: boolean): AiConversationNodeOf<'tool'> {
  const events = readRecoveryCapture as readonly AgentSessionEvent[];
  const tools = projectAgentChatNodes(recovered ? events : events.slice(0, 2))
    .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
    .filter((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool');
  return tools[0];
}

const command = 'powershell $f="$env:USERPROFILE\\todo.html"; $c=Get-Content $f; Write-Output $c';
const node: AiConversationNodeOf<'tool'> = {
  kind: 'tool', key: 'tool:long-command', sourceKind: 'agent',
  sessionId: 'tool-presentation', turnId: 'turn-1', stepId: 'step-1',
  firstSeq: 1, lastSeq: 2, timestamp: '2026-09-19T00:00:00.000Z',
  callId: 'long-command', name: 'run_terminal_command', nativeName: null, title: null,
  summary: 'Read the file', state: 'succeeded', effect: 'readOnly', durationMs: 1,
  evidenceRefs: [], detailRef: { kind: 'agentTool', sessionId: 'tool-presentation', callId: 'long-command' },
  input: { command }, output: 'File contents', error: null,
  target: null, idempotency: null, approval: null,
};

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('AI tool presentation', () => {
  it.each(['zh-CN', 'en-US'] as const)('shows the recorded plan as a structured surface inline in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const plan = projectAgentChatNodes(conversationFoldRecording.completed.events)
      .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
      .find((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool' && item.name === 'update_plan');
    expect(plan).toBeDefined();
    const { container } = render(<AiToolRow node={plan!} />);
    await userEvent.setup().click(screen.getByRole('button'));
    const surface = container.querySelector('[data-ai-tool-view="plan"]');
    expect(surface).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(0);
    const headerTitle = surface?.querySelector('.ai-content-title');
    expect(headerTitle).toHaveTextContent(locale === 'zh-CN' ? '5 已完成' : '5 completed');
    expect(headerTitle?.querySelector('.ai-plan-version')).toHaveTextContent('v7');
    expect(surface?.querySelector('.ai-plan-explanation')).toHaveTextContent('本轮仅使用只读工具');
    const stepItems = surface?.querySelectorAll('.ai-plan-step') ?? [];
    expect(stepItems).toHaveLength(5);
    expect(stepItems[0]).toHaveAttribute('data-status', 'completed');
    expect(stepItems[0]).toHaveTextContent('清点剩余未细读模块与协议文档');
    expect(stepItems[0]).toHaveTextContent('list_directory 获取 src-tauri/src/agent_runtime');
    expect(screen.queryByText(locale === 'zh-CN' ? '查看详情' : 'View details')).not.toBeInTheDocument();
  });

  it('normalizes update_plan step aliases and falls back to raw IO on failure or empty payload', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const aliasNode: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:plan-alias',
      callId: 'plan-alias',
      name: 'update_plan',
      title: 'Update task plan',
      input: {
        steps: [
          { step: 'Inspect logs', status: 'in_progress', description: 'Check recent errors' },
          { id: 'verify', status: 'blocked' },
        ],
      },
      output: null,
    };
    const { container, rerender } = render(<AiToolExpandedContent node={aliasNode} />);
    const planSurface = container.querySelector('[data-ai-tool-view="plan"]');
    expect(planSurface).toBeInTheDocument();
    expect(planSurface?.querySelector('.ai-content-title')).toHaveTextContent('1 进行中 · 1 已阻塞');
    const items = planSurface?.querySelectorAll('.ai-plan-step') ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-status', 'inProgress');
    expect(items[0]).toHaveTextContent('Inspect logs');
    expect(items[0]).toHaveTextContent('Check recent errors');
    expect(items[1]).toHaveAttribute('data-status', 'blocked');
    expect(items[1]).toHaveTextContent('verify');

    rerender(<AiToolExpandedContent node={{ ...aliasNode, state: 'failed', output: { error: 'Invalid plan' } }} />);
    expect(container.querySelector('[data-ai-tool-view="plan"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-ai-tool-view="generic"]')).toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('renders every specialized inline tool surface in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const path = `${process.cwd()}/package.json`;
    const file = readFileSync(path, 'utf8');
    const codePath = 'scripts/checks/check-ai-panel-styles.mjs';
    const code = readFileSync(codePath, 'utf8');
    const execution = spawnSync(process.execPath, [codePath], { encoding: 'utf8' });
    expect(execution.status).toBe(0);
    const search = spawnSync('rg', ['--line-number', '"version"', path], { encoding: 'utf8' });
    expect(search.status).toBe(0);
    const cases = [
      { name: 'run_terminal_command', input: { command: `node ${codePath}` }, output: { stdout: execution.stdout, exitCode: 0 }, result: execution.stdout.trimEnd(), selector: '[data-ai-terminal-output]' },
      { name: 'run_code', input: { code, language: 'javascript' }, output: { stdout: execution.stdout }, result: execution.stdout, selector: '.ai-code-output pre' },
      { name: 'read_file', input: { path }, output: file, result: file, selector: '.ai-read-lines' },
      { name: 'search_text', input: { query: '"version"', path }, output: search.stdout, result: search.stdout.replace(/\n$/u, ''), selector: '.ai-search-results' },
      { name: 'web_fetch', input: { url: new URL(`file://${path}`).href }, output: file, result: file, selector: '.ai-web-content pre' },
      { name: 'trash_file', input: { path }, state: 'uncertain' as const, output: { path }, result: JSON.stringify({ path }, null, 2), selector: '.ai-io-output pre' },
    ];
    const user = userEvent.setup();
    for (const entry of cases) {
      const tool = { ...node, ...entry };
      const { container, unmount } = render(<AiToolRow node={tool} />);
      await user.click(screen.getByRole('button'));
      if (entry.name === 'run_terminal_command') expect(container.querySelector('.ai-terminal-command-row')).toHaveTextContent(`node ${codePath}`);
      else if (entry.name === 'run_code') {
        expect(container.querySelector('.ai-code-content pre')?.textContent).toBe(code);
        expect(container.querySelectorAll('[data-ai-tool-view="code"] .ai-tool-surface-header')).toHaveLength(1);
        expect(container.querySelector('.ai-code-footer')).toHaveTextContent(locale === 'zh-CN' ? /^成功$/u : /^Succeeded$/u);
      }
      else if (entry.name === 'trash_file') expect(container.querySelector('.ai-io-input')).toBeInTheDocument();
      else expect(container.querySelector('.ai-tool-surface-header')).toBeInTheDocument();
      expect(container.querySelector(entry.selector), entry.name).toBeVisible();
      expect(screen.queryByText(locale === 'zh-CN' ? '查看详情' : 'View details'), entry.name).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows the exit code when code execution fails after producing output', () => {
    const code = 'throw new Error(process.version)';
    const execution = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8' });
    expect(execution.status).toBe(1);
    const { container } = render(<AiToolExpandedContent node={{
      ...node,
      name: 'run_code',
      input: { language: 'javascript', code },
      output: { stderr: execution.stderr, exitCode: execution.status },
      state: 'failed',
    }} />);
    expect(container.querySelector('.ai-code-output pre')?.textContent).toBe(execution.stderr);
    expect(container.querySelector('.ai-code-footer')).toHaveTextContent(/^Exit 1$/u);
    expect(container.querySelector('.ai-code-footer svg')).not.toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('falls back to plain output when a large patch exceeds diff bounds in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const artifacts = join(process.cwd(), 'artifacts/tests/ai-tool-presentation');
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(join(artifacts, 'large-diff-'));
    const before = join(directory, 'before.txt'), after = join(directory, 'after.txt');
    writeFileSync(before, 'Original content\n');
    writeFileSync(after, Array.from({ length: 3000 }, (_, index) => `Changed line ${index}: large patch presentation fixture\n`).join(''));
    const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', before, after], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1); // git diff reports actual differences with exit 1.
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    const patchNode = { ...node, name: 'apply_patch', input: { patch: result.stdout }, output: { diff: result.stdout } };
    const { container } = render(<AiToolExpandedContent node={patchNode} />);
    expect(container.querySelector('.ai-diff-block')).toBeNull();
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(2);
    expect(container.querySelector('.ai-io-input')).toBeInTheDocument();
    expect(container.querySelector('.ai-io-output pre')?.textContent).toBe(JSON.stringify(patchNode.output, null, 2).slice(0, 64 * 1024) + '\n…');
  });

  it.each(['zh-CN', 'en-US'] as const)('separates input and output into independently scrollable content boxes in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const execution = spawnSync('git', ['log', '--oneline', '-3'], { encoding: 'utf8' });
    expect(execution.status).toBe(0);
    const { container } = render(<AiToolExpandedContent node={{
      ...node, name: 'git', input: { command: 'git log --oneline -3' }, output: execution.stdout,
    }} />);
    const sections = [...container.querySelectorAll('.ai-io-section')];
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveTextContent('git log --oneline -3');
    expect(sections[1].querySelector('pre')?.textContent).toBe(execution.stdout);
    expect(sections[0].querySelector('.ai-io-label')).toHaveTextContent(locale === 'zh-CN' ? '输入' : 'IN');
    expect(sections[1].querySelector('.ai-io-label')).toHaveTextContent(locale === 'zh-CN' ? '输出' : 'OUT');
    for (const section of sections) {
      expect(section).toHaveClass('overflow-hidden');
      expect(section.parentElement).toBe(container.querySelector('.ai-io-card'));
      const header = section.querySelector('.ai-tool-surface-header');
      expect(header).toContainElement(section.querySelector('.ai-io-label'));
      const body = section.querySelector('.ai-tool-content-region');
      expect(header?.nextElementSibling).toBe(body);
      expect(body).toContainElement(section.querySelector('pre'));
      expect(body).toContainElement(section.querySelector('.ai-tool-copy-button'));
      expect(header?.querySelector('.ai-tool-copy-button')).toBeNull();
    }
    expect(container.querySelector('.ai-io-card')).toHaveClass('gap-2');
    expect(container.querySelector('.ai-io-card')).not.toHaveClass('overflow-hidden');
    expect(container.querySelector('.ai-io-input')).toHaveClass('max-h-65');
    expect(container.querySelector('.ai-io-output')).toHaveClass('max-h-65');
    expect(container.querySelector('.ai-io-card [data-slot="scroll-area-viewport"]')).toHaveStyle({ overflow: 'scroll' });
    expect(container.querySelector('.ai-io-divider, [data-slot="separator"]')).not.toBeInTheDocument();
  });

  it('renders only populated generic content boxes while waiting for output or when input is absent', () => {
    const execution = spawnSync('git', ['log', '--oneline', '-3'], { encoding: 'utf8' });
    expect(execution.status).toBe(0);
    const input = { command: 'git log --oneline -3' };
    const { container, rerender } = render(<AiToolExpandedContent node={{
      ...node, name: 'git', input, state: 'running', output: null,
    }} />);
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(1);
    expect(container.querySelector('.ai-io-input')).toHaveTextContent(input.command);
    expect(container.querySelector('.ai-io-output')).toBeNull();

    rerender(<AiToolExpandedContent node={{ ...node, name: 'git', input, output: execution.stdout }} />);
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(2);
    expect(container.querySelector('.ai-io-output pre')?.textContent).toBe(execution.stdout);

    rerender(<AiToolExpandedContent node={{ ...node, name: 'git', input: null, output: execution.stdout }} />);
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(1);
    expect(container.querySelector('.ai-io-input')).toBeNull();
    expect(container.querySelector('.ai-io-output pre')?.textContent).toBe(execution.stdout);

    rerender(<AiToolExpandedContent node={{ ...node, name: 'git', input: null, output: null }} />);
    expect(container.querySelectorAll('.ai-io-section')).toHaveLength(0);
  });

  it.each(['read_file', 'search_text'])('shows every real %s result in a capped scrollable body', name => {
    const path = 'package.json';
    const execution = name === 'search_text' ? spawnSync('rg', ['--line-number', '.', path], { encoding: 'utf8' }) : null;
    if (execution) expect(execution.status).toBe(0);
    const output = execution?.stdout ?? readFileSync(path, 'utf8');
    const { container } = render(<AiToolExpandedContent node={{
      ...node, name, input: { path, query: '.' }, output,
    }} compact />);
    const body = container.querySelector('.ai-read-lines, .ai-search-results');
    expect(body).toHaveClass('max-h-65', 'overflow-auto');
    expect(body).toHaveAttribute('tabindex', '0');
    const rows = container.querySelectorAll('.ai-read-line, .ai-search-result');
    expect(rows).toHaveLength(name === 'read_file' ? output.split('\n').length : output.split('\n').filter(Boolean).length);
    expect(body).not.toHaveTextContent(/… \d+ (lines|results) omitted …/u);
  });

  it('keeps every line of real command output inside the capped transcript', () => {
    const execution = spawnSync('rg', ['--files', '--no-ignore', 'src/components/ai/styles'], { encoding: 'utf8' });
    expect(execution.error).toBeUndefined();
    expect(execution.status).toBe(0);
    const lines = execution.stdout.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(8);
    const { container } = render(<AiToolExpandedContent node={{
      ...node, input: { command: 'rg --files --no-ignore src/components/ai/styles' },
      output: { stdout: execution.stdout, exitCode: execution.status },
    }} compact />);
    const transcript = container.querySelector('.ai-terminal-transcript');
    expect(transcript).toHaveClass('max-h-65', 'overflow-hidden');
    expect(transcript?.querySelector('[data-slot="scroll-area-viewport"]')).toHaveStyle({ overflow: 'scroll' });
    expect([...container.querySelectorAll('.ai-block-line')].map(line => line.textContent)).toEqual(lines);
    expect(container.querySelector('.ai-block-fold')).not.toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('shows a Shell transcript and localized exit code from a real failed command in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const args = ['show', 'HEAD:__shellspan_missing_file_for_presentation_check__'];
    const execution = spawnSync('git', args, { encoding: 'utf8' });
    expect(execution.error).toBeUndefined();
    expect(execution.status).not.toBe(0);
    const { container } = render(<AiToolExpandedContent node={{
      ...node,
      input: { command: `git ${args.join(' ')}`, cwd: process.cwd() },
      target: { kind: 'local', targetId: hostname(), sessionId: node.sessionId, label: hostname() },
      state: 'failed', summary: execution.stderr, error: execution.stderr,
      output: { stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.status },
    }} />);
    expect(container.querySelector('.ai-terminal-header')).toHaveTextContent('Shell');
    expect(container.querySelector('.ai-terminal-cwd')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-header')).not.toHaveTextContent(process.cwd());
    expect(container.querySelector('.ai-terminal-header')).not.toHaveTextContent(hostname());
    expect(container.querySelector('.ai-terminal-exit')).toHaveTextContent(
      `${locale === 'zh-CN' ? '退出码' : 'Exit'} ${execution.status}`,
    );
    expect(container.querySelector('[data-ai-terminal-output]')).toHaveTextContent(execution.stderr.trim());
    expect(container.querySelector('[data-ai-terminal-output] .ai-tool-surface-header')).toBeNull();
    expect(container.querySelectorAll('.ai-tool-surface-header')).toHaveLength(1);
    expect(screen.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy output' })).toBeVisible();
    expect(container.querySelector('.ai-terminal-transcript')).toHaveClass('max-h-65', 'overflow-hidden');
    expect(container.querySelector('.ai-terminal-transcript [data-slot="scroll-area-viewport"]')).toHaveAttribute('aria-label', 'Shell');
  });

  it.each(['zh-CN', 'en-US'] as const)('keeps recovered read errors compact and shows one diagnostic when expanded in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    const failure = capturedRead(false);
    const { container, rerender } = render(<AiToolRow node={failure} />);
    const row = screen.getByRole('button');
    expect(row).not.toHaveTextContent(failure.error!);
    await user.click(row);
    expect(screen.getAllByText(failure.error!)).toHaveLength(1);
    const copy = screen.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy output' });
    expect(copy).toBeVisible();
    expect(container.querySelector('[data-ai-tool-view="error"] .ai-tool-surface-header')).toBeNull();
    expect(screen.queryByText(locale === 'zh-CN' ? '查看错误详情' : 'View error details')).not.toBeInTheDocument();
    expect(copy.closest('[data-ai-copy-region]')).toBe(copy.closest('.ai-tool-content-region'));
    expect(copy.closest('.ai-tool-content-region')).toContainElement(container.querySelector('code'));
    expect(copy).toHaveClass('absolute');
    expect(container.querySelector('[data-ai-tool-view="error"] code')).toHaveTextContent(failure.error!);
    expect(container.querySelector('[data-ai-tool-view="error"] pre')).toHaveClass('ai-content-code', 'px-3.5', 'py-2');
    expect(container.querySelector('[data-ai-tool-view="error"] pre')).toHaveAttribute('tabindex', '0');
    expect(container.querySelector('.ai-read-line')).toBeNull();
    expect(container.querySelector('[data-error]')).toBeInTheDocument();

    rerender(<AiToolRow node={capturedRead(true)} />);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveTextContent(locale === 'zh-CN' ? '重试读取成功' : 'Read retry succeeded');
    expect(container.querySelector('.ai-disclosure-summary')).not.toHaveAttribute('data-error');
    expect(container.querySelector('.ai-state-dot[data-state="failed"]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'zh-CN' ? '读取已恢复' : 'Read recovered');
    row.focus();
    await user.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(failure.error!)).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['zh-CN', 'en-US'] as const)('localizes the captured skill tool title in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const nodes = projectAgentChatNodes(skillsCapture as unknown as readonly AgentSessionEvent[]);
    const skill = nodes.flatMap((item) => item.kind === 'turnProcess' ? item.children : [])
      .find((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool' && item.name === 'skill');
    expect(skill).toBeDefined();
    render(<AiToolRow node={skill!} />);
    const title = locale === 'zh-CN' ? '加载技能' : 'Load Skill';
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByRole('button', { name: new RegExp(`^${title}:`) })).toBeVisible();
    if (locale === 'zh-CN') expect(screen.queryByText('Load Skill')).not.toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('shows system-trash recovery without promising in-app undo in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const trashNode: AiConversationNodeOf<'tool'> = {
      ...node, name: 'trash_file', effect: 'destructive',
      input: { path: 'old-config.json' },
      output: { path: 'old-config.json', trashed: true, recovery: 'systemTrash' },
    };
    render(<AiToolRow node={trashNode} />);
    const label = locale === 'zh-CN' ? '移入系统回收站' : 'Move to system trash';
    const row = screen.getByRole('button', { name: new RegExp(label) });
    expect(row).toHaveTextContent('old-config.json');
    await userEvent.setup().click(row);
    expect(screen.getByText(locale === 'zh-CN'
      ? '已移入系统回收站。请在系统回收站中恢复；当前不支持应用内一键撤销。'
      : 'Moved to the system trash. Restore it there; in-app undo is not available.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /撤销删除|Undo deletion/u })).not.toBeInTheDocument();
  });

  it('does not report recovery success when trashing fails', () => {
    render(<AiToolExpandedContent node={{ ...node, name: 'trash_file', state: 'failed', output: 'trash unavailable', error: 'trash unavailable' }} />);
    expect(screen.queryByText(/Moved to the system trash/u)).not.toBeInTheDocument();
    expect(screen.getByText('trash unavailable')).toBeVisible();
  });

  it('explains a protected operation denial while retaining the original diagnostic', async () => {
    const error = 'AGENT_CRITICAL_OPERATION_DENIED: protected system resource';
    render(<AiToolRow node={{ ...node, state: 'failed', error, output: error }} />);
    const row = screen.getByRole('button', { name: /Not executed: this action affects protected system resources/u });
    expect(row).not.toHaveTextContent('AGENT_CRITICAL_OPERATION_DENIED');
    await userEvent.setup().click(row);
    expect(screen.getByText(error)).toBeVisible();
  });

  it.each(['zh-CN', 'en-US'] as const)('explains the captured HTTP/SSH timeout without claiming a service outage in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const diagnostic = 'Target loopback HTTP request exceeded its total deadline; target loopback SSH transport exceeded its total deadline';
    const probe: AiConversationNodeOf<'tool'> = {
      ...node, name: 'probe_http', state: 'failed', summary: diagnostic,
      input: { method: 'get', port: 80, path: '/' }, output: diagnostic, error: null,
    };
    const { container } = render(<AiToolRow node={probe} />);
    const row = screen.getByRole('button', { name: locale === 'zh-CN'
      ? 'HTTP 检查: HTTP 健康检查超时' : 'HTTP check: HTTP health check timed out' });
    expect(row).not.toHaveTextContent('total deadline');
    expect(container.querySelector('[data-tool-state="failed"]')).toBeInTheDocument();
    row.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(locale === 'zh-CN'
      ? 'SSH 探测通道超时，暂时无法确认 HTTP 服务响应。请结合服务状态和主机本地检查结果判断。'
      : 'The SSH probe transport timed out; the HTTP response remains unverified. Check the service status and results from a check on the host.')).toBeVisible();
    expect(screen.getByText(diagnostic)).toBeVisible();
  });

  it('keeps a non-timeout HTTP failure intact and preserves successful responses', () => {
    const error = 'failed to open SSH channel: administratively prohibited';
    const { rerender } = render(<AiToolExpandedContent node={{ ...node, name: 'probe_http', state: 'failed', summary: error, error, output: error }} />);
    expect(screen.queryByText('HTTP health check timed out')).not.toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name: 'probe_http', output: { status: 503, body: 'Service Unavailable' } }} />);
    expect(screen.getByText('Service Unavailable')).toBeVisible();
    expect(screen.queryByText(/remains unverified/u)).not.toBeInTheDocument();
  });

  it('explains a changed automatic review without implying a shell fallback', () => {
    const error = 'AUTO_REVIEW_CHANGED: reviewed root identity changed';
    render(<AiToolRow node={{ ...node, state: 'failed', error, output: error }} />);
    expect(screen.getByRole('button', { name: /no ordinary shell fallback was run/u })).toBeVisible();
  });
  it.each([
    { locale: 'zh-CN' as const, label: '查看详情', copyCommand: '复制命令', copyOutput: '复制输出' },
    { locale: 'en-US' as const, label: 'View details', copyCommand: 'Copy command', copyOutput: 'Copy output' },
  ])('keeps completed command output inline without the details action in $locale', async ({ locale, label, copyCommand, copyOutput }) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const execution = spawnSync('git', ['--version'], { encoding: 'utf8' });
    expect(execution.status).toBe(0);
    const result = {
      ...node,
      input: { command: 'git --version', description: 'Report the Git version' },
      output: { execution: 'completed', stdout: execution.stdout, exitCode: execution.status },
    };
    render(<AiToolRow node={result} />);
    const user = userEvent.setup();
    const row = screen.getByRole('button');
    row.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('git --version')).toBeVisible();
    expect(screen.getByText(execution.stdout.trim())).toBeVisible();
    expect(screen.getByRole('button', { name: copyCommand })).toBeVisible();
    expect(screen.getByRole('button', { name: copyOutput })).toBeVisible();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('explains rejected historical input with structured output in %s', async (locale) => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const diagnostic = 'ephemeralInputUnavailable: no input was executed; historical input is unavailable.';
    // Rejected tool results carry their diagnostic in summary; their output is
    // the structured receipt and the projected error field is null.
    const receipt = {
      code: 'ephemeralInputUnavailable', executed: false,
      recoveryAction: 'readCurrentStateAndReconstructInput', retryable: false,
    };
    const rejected: AiConversationNodeOf<'tool'> = {
      ...node, state: 'rejected', error: null, summary: diagnostic, output: receipt,
    };
    render(<AiToolRow node={rejected} />);
    const row = screen.getByRole('button', { name: locale === 'zh-CN'
      ? /未执行：Agent 使用了已省略的历史输入，需要重新生成命令。/u
      : /Not executed: the Agent used omitted historical input/u });
    expect(row).not.toHaveTextContent('ephemeralInputUnavailable');
    expect(row).not.toHaveTextContent('{');
    await userEvent.setup().click(row);
    expect(screen.getByText(/"code": "ephemeralInputUnavailable"/u)).toBeInTheDocument();
  });

  it('shows update_plan as a localized task plan with a list icon', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const planNode: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:plan',
      callId: 'plan',
      name: 'update_plan',
      title: 'Update task plan',
      summary: 'Updated task plan: 2 pending, 1 in progress',
      input: { steps: [] },
    };

    expect(classifyAiTool('update_plan')).toBe('plan');
    expect(classifyAiTool('provider.tool', 'update_plan')).toBe('plan');
    const { container } = render(<AiToolRow node={planNode} />);
    expect(container.querySelector('[data-tool-variant="plan"]')).toBeInTheDocument();
    expect(container.querySelector('.lucide-list-todo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^更新任务计划:/u })).toBeInTheDocument();
    const summary = container.querySelector('.ai-disclosure-summary');
    expect(summary).toHaveTextContent('1 进行中 · 2 待处理');
    expect(summary).toHaveClass('truncate');
    expect(summary).not.toHaveClass('line-clamp-2');
    await userEvent.setup().click(screen.getByRole('button', { name: /^更新任务计划:/u }));
    expect(summary).toHaveClass('truncate');
    expect(summary).not.toHaveClass('whitespace-pre-wrap', 'overflow-auto');
  });

  it('localizes update_plan step counts and prefers explanation when provided', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const stepsInput = {
      steps: [
        { step: 'Inspect logs', status: 'in_progress' },
        { step: 'Confirm scope', status: 'pending' },
        { step: 'Clean logs', status: 'pending' },
        { step: 'Verify disk', status: 'pending' },
      ],
    };
    const stepsNode: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:plan-steps',
      callId: 'plan-steps',
      name: 'update_plan',
      title: 'Update task plan',
      summary: 'Updated task plan: 3 pending, 1 in progress, 0 completed, 0 blocked, 0 failed (version 1)',
      input: stepsInput,
    };

    const { container, rerender } = render(<AiToolRow node={stepsNode} />);
    expect(container.querySelector('.ai-disclosure-summary')).toHaveTextContent('1 进行中 · 3 待处理');

    rerender(
      <AiToolRow
        node={{
          ...stepsNode,
          input: { ...stepsInput, explanation: '先检查磁盘与日志现状' },
        }}
      />,
    );
    expect(container.querySelector('.ai-disclosure-summary')).toHaveTextContent('先检查磁盘与日志现状');
  });

  it('limits command input to two lines and expands it with one click', async () => {
    const user = userEvent.setup();
    const { container } = render(<AiToolExpandedContent node={node} compact />);
    const toggle = screen.getByRole('button', { name: 'Show full command' });

    expect(toggle).toHaveTextContent(command);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.firstElementChild).toHaveClass('line-clamp-2');
    expect(container.querySelector('.ai-terminal-command')).toBe(toggle);
    const commandTitle = toggle.closest('.ai-content-title');
    expect(commandTitle).toHaveClass('ai-tool-scroll-area');
    expect(commandTitle).toHaveAttribute('data-slot', 'scroll-area');
    expect(commandTitle?.querySelector('[data-slot="scroll-area-viewport"]')).toContainElement(toggle);
    const header = container.querySelector('.ai-terminal-header');
    const stateDot = header?.querySelector('.ai-state-dot');
    expect(header).toHaveTextContent('Shell');
    expect(header).toHaveClass('items-center');
    expect(header).not.toContainElement(toggle);
    expect(stateDot).not.toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-prompt')).toHaveTextContent('$');
    expect(container.querySelector('.ai-terminal-command-row')).toHaveClass('py-1');
    expect(container.querySelector('.ai-terminal-command-row')).not.toHaveClass('pb-3');
    expect(container.querySelector('.ai-terminal-output')).toContainElement(toggle);

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse command' })).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.firstElementChild).toHaveClass('block');
    expect(toggle.firstElementChild).not.toHaveClass('line-clamp-2');
    expect(commandTitle).toHaveClass('max-h-[6lh]');
    expect(commandTitle).not.toHaveClass('overflow-auto');
    expect(header).toHaveClass('items-center');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show full command' })).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.firstElementChild).toHaveClass('line-clamp-2');
    expect(header).toHaveClass('items-center');
  });

  it('provides separate command and output copy icons, including while running', () => {
    const { container, rerender } = render(<AiToolExpandedContent node={node} compact />);
    const commandCopy = screen.getByRole('button', { name: 'Copy command' });
    const outputCopy = screen.getByRole('button', { name: 'Copy output' });
    expect(commandCopy.closest('.ai-tool-content-region')).toContainElement(container.querySelector('.ai-terminal-command-row'));
    expect(outputCopy.closest('[data-ai-terminal-output]')).toBeInTheDocument();
    expect(commandCopy.closest('[data-ai-copy-region]')).not.toBe(outputCopy.closest('[data-ai-copy-region]'));
    expect(commandCopy.querySelector('svg')).toBeInTheDocument();
    expect(outputCopy.querySelector('svg')).toBeInTheDocument();
    rerender(<AiToolExpandedContent node={node} showCopyActions={false} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, state: 'running' }} />);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, state: 'running', output: null }} />);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy output' })).not.toBeInTheDocument();
    expect(screen.queryByText('No output')).not.toBeInTheDocument();
  });

  it.each(['read_file'])('separates the %s path and output copy actions', (name) => {
    const input = { path: 'package.json' };
    const output = readFileSync(input.path, 'utf8');
    const { container, rerender } = render(<AiToolExpandedContent node={{ ...node, name, input, output }} compact />);
    const copy = screen.getByRole('button', { name: 'Copy output' });
    const inputCopy = screen.getByRole('button', { name: 'Copy input' });
    expect(container.querySelectorAll('.ai-tool-copy-button')).toHaveLength(2);
    expect(inputCopy).toHaveClass('static', 'shrink-0');
    expect(inputCopy.closest('.ai-tool-surface-header')).toHaveClass('ai-content-header', 'min-h-6', 'px-3.5');
    expect(copy.closest('.ai-tool-surface-header')).not.toBeInTheDocument();
    expect(copy.parentElement).toHaveAttribute('data-ai-copy-region');
    expect(copy.parentElement).toHaveClass('relative');
    expect(container.querySelectorAll('.ai-tool-surface-header')).toHaveLength(1);
    expect(screen.queryByText('OUT', { exact: true })).not.toBeInTheDocument();
    expect([...container.querySelectorAll('.ai-read-line > span:last-child')].map(line => line.textContent)).toEqual(output.split('\n').map(line => line || '\u00a0'));
    expect(copy.closest('[data-ai-copy-region]')).not.toBe(inputCopy.closest('[data-ai-copy-region]'));
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();

    rerender(<AiToolExpandedContent node={{ ...node, name }} showCopyActions={false} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name, output: '' }} />);
    expect(screen.queryByRole('button', { name: 'Copy output' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy input' })).toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name, state: 'running' }} />);
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name, input: null, output: null }} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
  });

  it('keeps diff headers outside the horizontal scrolling body and shows changes inline', async () => {
    const path = 'src/components/ai/workspace/ai-tool-presentation.tsx';
    // Use a real Git diff of owned files, without depending on repository
    // discovery, commit objects or the caller's mutable working tree.
    const parent = join(process.cwd(), 'artifacts/tests/ai-tool-diff');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'case-'));
    const before = join(directory, 'before.tsx'), after = join(directory, 'after.tsx');
    const source = readFileSync(path, 'utf8');
    writeFileSync(before, source); writeFileSync(after, source + '\n// owned diff fixture\n');
    const result = spawnSync('git', ['diff', '--no-index', '--unified=20', '--', before, after], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1); // Git reports an actual difference with exit 1.
    expect(result.stdout).not.toBe('');
    const patchNode = { ...node, name: 'apply_patch', input: { patch: result.stdout }, output: { diff: result.stdout } };
    const { container } = render(<AiToolRow node={patchNode} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(screen.queryByText('View details')).not.toBeInTheDocument();
    const viewport = container.querySelector('.ai-diff-block [data-slot="scroll-area-viewport"]');
    expect(viewport?.closest('.ai-diff-content')).toHaveClass('max-h-65');
    for (const body of container.querySelectorAll('.ai-diff-body')) {
      expect(body.closest('[data-slot="scroll-area-viewport"]')).not.toContainElement(body.closest('section')?.querySelector('.ai-tool-surface-header') ?? null);
    }
    expect(container.querySelectorAll('.ai-diff-body').length).toBeGreaterThan(0);
    const titles = [...container.querySelectorAll('.ai-diff-block .ai-content-title')].map(title => title.textContent);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('opens stored tool outputs directly from the expanded tool row without a details page', async () => {
    const user = userEvent.setup();
    const onOpenStoredOutput = vi.fn();
    const read = capturedRead(true);
    const { rerender } = render(<AiToolRow node={read} onOpenStoredOutput={onOpenStoredOutput} />);

    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('button', { name: `Open details for ${read.name}` })).not.toBeInTheDocument();
    expect(screen.queryByText('View details')).not.toBeInTheDocument();

    const storedArtifactId = `artifact-${'a'.repeat(32)}`;
    const storedNode: AiConversationNodeOf<'tool'> = {
      ...node,
      name: 'http_probe',
      output: { artifactRef: storedArtifactId, readWith: 'read_tool_result', status: 200, truncated: true },
    };
    rerender(<AiToolRow node={storedNode} onOpenStoredOutput={onOpenStoredOutput} />);
    await user.click(screen.getByRole('button', { name: /^Web:/u }));
    const openStoredButton = screen.getByRole('button', { name: 'View saved output' });
    expect(openStoredButton.closest('.ai-web-block .ai-tool-surface-header')).not.toBeNull();
    await user.click(openStoredButton);
    expect(onOpenStoredOutput).toHaveBeenCalledExactlyOnceWith(storedNode, storedArtifactId);

    const storedTerminalNode: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:stored-terminal',
      name: 'run_terminal_command',
      input: { command: 'find /root -type f' },
      output: {
        artifactRef: storedArtifactId,
        readWith: 'read_tool_result',
        channel: 'terminal',
        execution: 'completed',
        exitCode: 0,
        stdout: '',
        stderr: '',
        combinedOutput: '=== CWD: /root ===\n23019431 pyi 9150',
        truncated: true,
      },
    };
    rerender(<AiToolRow node={storedTerminalNode} onOpenStoredOutput={onOpenStoredOutput} />);
    const terminalButton = screen.getByRole('button', { name: 'View saved output' });
    expect(terminalButton.closest('.ai-terminal-block .ai-tool-surface-header')).not.toBeNull();
    expect(screen.getByText(/=== CWD: \/root ===/u)).toBeInTheDocument();
    expect(screen.queryByText('No output')).not.toBeInTheDocument();
  });

  it('retains the target summary and shows an inline status label when a tool is rejected or fails without a localized error message', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const rejectedCommand: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:rejected-cmd',
      name: 'run_command',
      state: 'rejected',
      input: { command: 'ss -ltnp | grep 18999' },
      summary: 'TERMINAL_JOB_OWNER_MISMATCH',
      error: 'TERMINAL_JOB_OWNER_MISMATCH',
      output: null,
    };
    const { container, rerender } = render(<AiToolRow node={rejectedCommand} />);
    expect(container.querySelector('.ai-disclosure-summary')).toHaveTextContent('ss -ltnp | grep 18999');
    expect(container.querySelector('.ai-tool-meta')).toHaveTextContent('已拒绝');

    const failedRead: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:failed-read',
      name: 'read_file',
      state: 'failed',
      input: { path: '/proc/net/tcp' },
      summary: 'permission denied',
      error: 'permission denied',
      output: null,
    };
    rerender(<AiToolRow node={failedRead} />);
    expect(container.querySelector('.ai-disclosure-summary')).toHaveTextContent('/proc/net/tcp');
    expect(container.querySelector('.ai-tool-meta')).toHaveTextContent('失败');
  });
});

afterAll(() => {
  rmSync(join(process.cwd(), 'artifacts/tests/ai-tool-presentation'), { recursive: true, force: true });
  rmSync(join(process.cwd(), 'artifacts/tests/ai-tool-diff'), { recursive: true, force: true });
});

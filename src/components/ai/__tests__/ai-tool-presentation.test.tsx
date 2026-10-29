import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { AiToolExpandedContent, AiToolRow, classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import { AiToolDetails } from '@/components/ai/workspace/ai-tool-details';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import readRecoveryCapture from '@/test/fixtures/tool-result-read-recovery.json';
import { conversationFoldRecording } from '@/test/fixtures/conversation-fold-runtime';

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
  it.each(['zh-CN', 'en-US'] as const)('shows only the recorded plan result in the output detail section in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const plan = projectAgentChatNodes(conversationFoldRecording.completed.events)
      .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
      .find((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool' && item.name === 'update_plan');
    expect(plan).toBeDefined();
    const { container, rerender } = render(<AiToolDetails node={plan!} onBack={() => undefined} />);
    const sections = container.querySelectorAll('.ai-detail-section');
    expect(sections[0].querySelector('code')?.textContent).toBe(JSON.stringify(plan!.input, null, 2));
    expect(sections[1].querySelector('pre')?.textContent).toBe(JSON.stringify(plan!.output, null, 2));
    expect(sections[1].querySelectorAll('.ai-io-section')).toHaveLength(1);
    expect(sections[1].querySelector('.ai-io-label')).toBeNull();
    expect(sections[1].querySelectorAll('.ai-tool-copy-button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy Output' })).toBeVisible();

    rerender(<AiToolExpandedContent node={plan!} />);
    const inline = container.querySelectorAll('.ai-io-section');
    expect(inline).toHaveLength(2);
    expect(inline[0].querySelector('pre')?.textContent).toBe(JSON.stringify(plan!.input, null, 2));
    expect(inline[1].querySelector('pre')?.textContent).toBe(JSON.stringify(plan!.output, null, 2));
  });

  it('shows a real generic tool result without repeating its input in the details output', () => {
    const execution = spawnSync('git', ['log', '--oneline', '-3'], { encoding: 'utf8' });
    expect(execution.status).toBe(0);
    const input = { command: 'git log --oneline -3' };
    const { container } = render(<AiToolDetails node={{
      ...node, name: 'git', input, output: execution.stdout,
    }} onBack={() => undefined} />);
    const sections = container.querySelectorAll('.ai-detail-section');
    expect(sections[0].querySelector('code')?.textContent).toBe(JSON.stringify(input, null, 2));
    expect(sections[1].querySelector('pre')?.textContent).toBe(execution.stdout);
    expect(sections[1].querySelectorAll('.ai-io-section')).toHaveLength(1);
  });

  it.each(['zh-CN', 'en-US'] as const)('puts each input and output label above its real content in %s', async locale => {
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
      const header = section.querySelector('.ai-tool-surface-header');
      expect(header).toContainElement(section.querySelector('.ai-io-label'));
      expect(header?.nextElementSibling).toBe(section.querySelector('pre'));
      expect(header).toContainElement(section.querySelector('.ai-tool-copy-button'));
      expect(section.querySelector('.ai-tool-copy-button')).toHaveClass('static', 'shrink-0');
    }
    expect(container.querySelector('.ai-io-card')).toHaveClass('max-h-65', 'overflow-hidden');
    expect(container.querySelector('.ai-io-card [data-slot="scroll-area-viewport"]')).toHaveStyle({ overflow: 'scroll' });
    expect(container.querySelector('.ai-io-divider, [data-slot="separator"]')).not.toBeInTheDocument();
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
    const execution = spawnSync('git', ['ls-files', 'src/components/ai/styles'], { encoding: 'utf8' });
    expect(execution.error).toBeUndefined();
    expect(execution.status).toBe(0);
    const lines = execution.stdout.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(8);
    const { container } = render(<AiToolExpandedContent node={{
      ...node, input: { command: 'git ls-files src/components/ai/styles' },
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
    expect(copy.closest('.ai-tool-surface-header')).toHaveTextContent(locale === 'zh-CN' ? '查看错误详情' : 'View error details');
    expect(copy).toHaveClass('static', 'shrink-0');
    expect(container.querySelector('[data-ai-tool-view="error"] code')).toHaveTextContent(failure.error!);
    expect(container.querySelector('[data-ai-tool-view="error"] pre')).toHaveClass('px-3.5', 'pt-1', 'pb-3');
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

  it.each(['zh-CN', 'en-US'] as const)('does not duplicate the captured error in the details page in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const failure = capturedRead(true);
    const { container, rerender } = render(<AiToolDetails node={failure} onBack={() => undefined} />);
    expect(screen.getAllByText(failure.error!)).toHaveLength(1);
    expect(container.querySelector('.ai-detail-error')).toBeNull();
    expect(container.querySelector('.ai-detail-summary')).not.toHaveTextContent(failure.error!);
    expect(container.querySelector('[data-ai-tool-view="error"] > .ai-block-banner')).toBeNull();
    expect(screen.queryByText(locale === 'zh-CN' ? '查看错误详情' : 'View error details')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy Output' })).toBeVisible();
    rerender(<AiToolDetails node={{ ...failure, output: null }} onBack={() => undefined} />);
    expect(screen.getAllByText(failure.error!)).toHaveLength(1);
    expect(container.querySelector('[data-ai-tool-view="error"] > .ai-block-banner')).toBeNull();
    // A separate diagnostic remains visible alongside distinct structured output.
    const success = projectAgentChatNodes(readRecoveryCapture as readonly AgentSessionEvent[])
      .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
      .find((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool' && item.state === 'succeeded')!;
    rerender(<AiToolDetails node={{ ...failure, output: success.output }} onBack={() => undefined} />);
    expect(screen.getAllByText(failure.error!)).toHaveLength(1);
    expect(container.querySelector('.ai-detail-error')).toHaveTextContent(failure.error!);
    expect(screen.getByText(/"nextOffset": 2048/u)).toBeVisible();
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
    { locale: 'zh-CN' as const, label: '查看详情', accessibleName: '打开 run_terminal_command 的详情' },
    { locale: 'en-US' as const, label: 'View details', accessibleName: 'Open details for run_terminal_command' },
  ])('labels the tool details action clearly in $locale', async ({ locale, label, accessibleName }) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const opened: AiConversationNodeOf<'tool'>[] = [];
    render(<AiToolRow node={node} onInspect={(tool) => opened.push(tool)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    const details = screen.getByRole('button', { name: accessibleName });
    expect(details).toHaveTextContent(label);
    expect(details).toHaveClass('ml-1', 'self-start');
    await user.click(details);
    expect(opened).toEqual([node]);
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
  });

  it('limits command input to two lines and expands it with one click', async () => {
    const user = userEvent.setup();
    const { container } = render(<AiToolExpandedContent node={node} compact />);
    const toggle = screen.getByRole('button', { name: 'Show full command' });

    expect(toggle).toHaveTextContent(command);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('line-clamp-2');
    expect(container.querySelector('.ai-terminal-command')).toBe(toggle);
    const header = container.querySelector('.ai-terminal-header');
    const stateDot = header?.querySelector('.ai-state-dot');
    expect(header).toHaveTextContent('Shell');
    expect(header).toHaveClass('items-center');
    expect(header).not.toContainElement(toggle);
    expect(stateDot).not.toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-prompt')).toHaveTextContent('$');
    expect(container.querySelector('.ai-terminal-output')).toContainElement(toggle);

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse command' })).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveClass('line-clamp-none');
    expect(toggle).not.toHaveClass('line-clamp-2');
    expect(header).toHaveClass('items-center');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show full command' })).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('line-clamp-2');
    expect(header).toHaveClass('items-center');
  });

  it('provides separate command and output copy icons, including while running', () => {
    const { container, rerender } = render(<AiToolExpandedContent node={node} compact />);
    const commandCopy = screen.getByRole('button', { name: 'Copy command' });
    const outputCopy = screen.getByRole('button', { name: 'Copy output' });
    expect(commandCopy.closest('.ai-terminal-header')).toBeInTheDocument();
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
    expect(inputCopy.closest('.ai-tool-surface-header')).toHaveClass('px-3.5', 'py-2');
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

  it('shows a leading icon on the inspect action and still opens tool details', async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    render(<AiToolRow node={node} onInspect={onInspect} />);

    await user.click(screen.getByRole('button', { name: /^Command:/u }));
    const inspect = screen.getByRole('button', { name: 'Open details for run_terminal_command' });
    expect(inspect.querySelector('svg[data-icon="inline-start"]')).toBeInTheDocument();
    expect(inspect).toHaveClass('gap-1');

    await user.click(inspect);
    expect(onInspect).toHaveBeenCalledExactlyOnceWith(node);
  });
});

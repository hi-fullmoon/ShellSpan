import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@/tests/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { createAiWorkspaceNavigationState } from '@/lib/ai/panel-route';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';
import { withOptimisticConversationNodes, withRetainedFailedSubmissions } from '@/lib/ai/optimistic-submission';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { agentSessionEventFixture, agentSessionWaitingApprovalEventFixture } from '@/tests/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/tests/fixtures/agent-session-baseline';
import { taskTokenBudgetView } from '@/tests/fixtures/task-token-budget';
import readRecoveryCapture from '@/tests/fixtures/tool-result-read-recovery.json';
import type { AgentSessionEvent } from '@/types/agent-session';
import { questionKey, type AnswerQuestionInput } from '@/types/agent-question';

function runningHierarchyView(): AiSessionView {
  const base = agentView('running');
  const nodes = base.nodes.map((node) => (
    node.kind === 'turnProcess' ? { ...node, status: 'running' as const } : node
  ));
  return {
    ...base,
    nodes,
    status: 'running',
    summary: { ...base.summary, status: 'running' },
  };
}

function agentView(status: AiSessionView['status'] = 'completed'): AiSessionView {
  const throughSeq = agentSessionEventFixture[agentSessionEventFixture.length - 1]?.seq ?? 0;
  return {
    summary: {
      id: 'session-fixture',
      kind: 'agent',
      title: 'Check nginx and report evidence.',
      updatedAt: '2026-09-02T08:00:02.000Z',
      status,
      scopeKey: 'terminal-fixture',
      archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: 'session-fixture',
          taskId: 'task-fixture',
          goal: 'Check nginx and report evidence.',
          executionSurface: 'direct',
          createdAtUnixMs: 1_000,
        },
        status,
        ended: status === 'completed' || status === 'failed' || status === 'cancelled',
        archived: false,
        eventCount: agentSessionEventFixture.length,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: {
          kind: 'idle',
          status: 'none',
          summary: 'fixture',
          lastCommittedSeq: throughSeq,
        },
      },
    },
    nodes: projectAgentChatNodes(agentSessionEventFixture),
    activityNodes: projectAgentActivity(agentSessionEventFixture).nodes,
    inbox: [],
    pendingApproval: null,
    status,
    error: null,
    throughSeq,
    canLoadOlder: false,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => cleanup());

it('lets a live one-shot child receive an approval decision with its input hidden', async () => {
  const user = userEvent.setup();
  const events = agentSessionWaitingApprovalEventFixture;
  const recorded = agentSessionView({ snapshot: agentView('waiting').snapshot.value, events,
    lastCommittedSeq: events[events.length - 1]!.seq, hasTerminalEvent: false });
  const subagent = { descriptorId: 'diagnostic', role: 'explorer' as const, continuable: false, depth: 1 };
  const view = { ...recorded, status: 'waiting' as const,
    summary: { ...recorded.summary, subagent, status: 'waiting' as const } };
  const choices: string[] = [];
  const renderWorkspace = (historicalTargetUnavailable = false) => (
    <AiWorkspaceRoot view={view} scope="terminal" mode="agent" readOnlySession
      historicalTargetUnavailable={historicalTargetUnavailable} onApprove={() => choices.push('approve')}
      onReject={() => choices.push('reject')} />
  );
  const { rerender } = render(renderWorkspace(true));
  expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  rerender(renderWorkspace());
  const approve = screen.getByRole('button', { name: 'Allow once' });
  expect(approve).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(approve);
  expect(choices).toEqual(['approve']);
});

it('warns and blocks pointer and keyboard submission during terminal contention, then preserves the draft for manual sending', async () => {
  const user = userEvent.setup();
  const sent: string[] = [];
  const props = {
    view: null,
    scope: 'terminal' as const,
    canStartAgent: true,
    defaultDraft: 'hello',
    onSubmit: ({ content }: { content: string }) => { sent.push(content); },
  };
  const { container, rerender } = render(<AiWorkspaceRoot {...props}
    terminalConflict agentUnavailableReason="Another Agent owns the terminal" />);
  const warning = await screen.findByRole('status', { name: 'Agent is unavailable' });
  expect(warning).toHaveTextContent('Another Agent owns the terminal');
  expect(warning).toHaveClass('text-app-warning');
  expect(warning).not.toHaveClass('[&:not(:has(button))>svg]:-translate-y-px');
  const send = container.querySelector<HTMLButtonElement>('.ai-composer-primary')!;
  expect(send).toBeDisabled();
  await user.click(send);
  const editor = screen.getByRole('textbox');
  await user.click(editor);
  await user.keyboard('{Enter}');
  expect(sent).toEqual([]);
  expect(editor).toHaveTextContent('hello');
  rerender(<AiWorkspaceRoot {...props} />);
  expect(screen.queryByText('Another Agent owns the terminal')).not.toBeInTheDocument();
  expect(send).toBeEnabled();
  expect(sent).toEqual([]);
  expect(editor).toHaveTextContent('hello');
  await user.click(send);
  expect(sent).toEqual(['hello']);
});

function failedSend(deliveryUnknown = false) {
  const view = taskTokenBudgetView();
  const requested = reduceAiComposer(createAiComposerState({
    sessionId: view.summary.id, draft: view.snapshot.value.header.goal,
  }), {
    type: 'submit.requested', clientOperationId: `${view.summary.id}:send`,
    gesture: 'primary', accelerated: false, now: view.snapshot.value.header.createdAtUnixMs,
    hasProvider: true, canCreateSession: true,
  }).state;
  const state = reduceAiComposer(requested, {
    type: 'submit.failed', clientOperationId: requested.pendingSubmissions[0].clientOperationId,
    error: normalizeAiSessionError(deliveryUnknown ? new AiAdmissionUnconfirmedError() : new AiPreparationTimeoutError()),
  }).state;
  const nodes = withOptimisticConversationNodes([], requested.pendingSubmissions.map(item => ({
    ...item, scopeKey: view.summary.scopeKey, expectedNextSeq: null,
    delivery: deliveryUnknown ? 'unconfirmed' as const : 'failed' as const,
  })), view.summary.scopeKey, view.summary.id);
  return { state, nodes };
}

it.each(['zh-CN', 'en-US'] as const)('keeps failed-send recovery beside its message without composer Alerts in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { state, nodes } = failedSend();
  const retried: string[] = [];
  const { container, rerender } = render(<AiWorkspaceRoot scope="workbench" view={null}
    pendingNodes={nodes} composerState={state} onRetryFailedDraft={id => retried.push(id)} />);
  const row = container.querySelector('[data-ai-failed-draft]')!;
  expect(row.closest('[data-slot="ai-workspace-content"]')).not.toBeNull();
  expect(container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
  expect(container.querySelectorAll('[data-ai-failed-draft]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(0);
  expect(screen.getAllByText(t('ai.workspace.messageNotSent'))).toHaveLength(1);
  expect(screen.getAllByText(state.failedDrafts[0].content)).toHaveLength(1);
  const retry = within(row as HTMLElement).getByRole('button', { name: t('common.retry') });
  expect(retry).toHaveClass('h-6', 'p-0', 'shrink-0');
  expect(retry).toHaveTextContent(t('common.retry'));
  retry.focus();
  await userEvent.setup().keyboard('{Enter}');
  expect(retried).toEqual([state.failedDrafts[0].id]);
  rerender(<AiWorkspaceRoot scope="workbench" view={null} pendingNodes={nodes}
    composerState={{ ...state, phase: 'stopping' }} onRetryFailedDraft={id => retried.push(id)} />);
  expect(retry).toBeDisabled();
  // Reopening rebuilds optimistic messages from retained application state.
  const restored = withRetainedFailedSubmissions([], state, 'ask:workbench');
  rerender(<AiWorkspaceRoot scope="workbench" view={null} composerState={state}
    pendingNodes={withOptimisticConversationNodes([], restored, 'ask:workbench', state.sessionId)}
    onRetryFailedDraft={id => retried.push(id)} />);
  expect(container.querySelector('[data-slot="ai-workspace-content"]')).toHaveTextContent(state.failedDrafts[0].content);
  expect(container.querySelector('[data-slot="ai-retained-failed-drafts"]')).toBeNull();
  expect(container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
  expect(container.querySelectorAll('[data-ai-failed-draft]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(0);
});

it('keeps a restored failure in a read-only transcript without offering resubmission or duplicating it above the input', async () => {
  const { state, nodes } = failedSend();
  const base = taskTokenBudgetView();
  const { container } = render(<AiWorkspaceRoot scope="workbench" readOnlySession
    view={{ ...base, nodes }} composerState={state} onRetryFailedDraft={() => undefined} />);
  const row = container.querySelector('[data-slot="ai-workspace-content"] [data-ai-failed-draft]')!;
  expect(row).toHaveTextContent(t('ai.workspace.messageNotSent'));
  await userEvent.setup().hover(within(row as HTMLElement).getByText(t('ai.workspace.messageNotSent')));
  expect(await screen.findByText(t('ai.workspace.error.preparationTimeout'))).toBeVisible();
  expect(row.querySelector('[data-ai-failed-retry]')).toBeNull();
  expect(container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
});

it.each(['zh-CN', 'en-US'] as const)('keeps receipt checks and synchronization recovery accessible without duplicate draft Alerts in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { state, nodes } = failedSend(true);
  const base = taskTokenBudgetView();
  let checks = 0;
  let finish!: () => void;
  const checking = new Promise<void>(resolve => { finish = resolve; });
  const { container } = render(<AiWorkspaceRoot scope="workbench" mode="ask"
    view={{ ...base, nodes, syncError: state.lastError!, syncRecovery: { attempts: 3, retrying: false } }}
    composerState={state} onRetrySync={() => { checks++; return checking; }}
    failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
  const row = container.querySelector('[data-ai-failed-draft]')!;
  expect(row.closest('[data-slot="ai-workspace-content"]')).not.toBeNull();
  expect(screen.getAllByText(t('ai.workspace.messageUnconfirmed'))).toHaveLength(1);
  expect(container.querySelector('[data-slot="ai-workspace-error-notices"] [data-ai-failed-draft]')).toBeNull();
  expect(container.querySelectorAll('[data-ai-error-notice]')).toHaveLength(1);
  const check = within(row as HTMLElement).getByRole('button', { name: t('ai.workspace.checkReceipt') });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(checks).toBe(1);
  expect(check).toBeDisabled();
  expect(check).toHaveAccessibleDescription(t('ai.error.childRecoveryBudgetExhausted'));
  await act(async () => { finish(); await checking; });
  expect(check).toBeEnabled();
});

describe('AiWorkspaceRoot conversation structure', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps the Agent header consistent with terminal availability in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { container, rerender } = render(<AiWorkspaceRoot mode="agent" scope="terminal" view={null} />);
    const context = (): HTMLElement => container.querySelector('.ai-session-context')!;
    expect(context()).toHaveTextContent(locale === 'zh-CN' ? '未连接终端' : 'No connected terminal');
    const target = 'root@175.178.66.45:22';
    rerender(<AiWorkspaceRoot mode="agent" scope="terminal" view={null} historyScopeLabel={target} terminalConnected />);
    expect(context()).toHaveTextContent(target);
    expect(context()).toHaveTextContent(locale === 'zh-CN' ? '已连接' : 'Connected');
    rerender(<AiWorkspaceRoot mode="agent" scope="terminal" view={null} historyScopeLabel={target} terminalConnected={false} />);
    expect(context()).toHaveTextContent(target);
    expect(context()).toHaveTextContent(locale === 'zh-CN' ? '未连接' : 'Disconnected');
    rerender(<AiWorkspaceRoot mode="ask" scope="workbench" view={null} />);
    expect(context()).toHaveTextContent(locale === 'zh-CN' ? '不读取终端' : 'No terminal context');
  });
  it('keeps durable identity independent of the displayed title and clears it for a new conversation', () => {
    const view = taskTokenBudgetView();
    const { container, rerender } = render(<AiWorkspaceRoot scope="terminal" view={view} title="Different display title" />);
    const workspace = () => container.querySelector('[data-slot="ai-workspace-root"]');
    expect(workspace()).toHaveAttribute('data-session-id', view.summary.id);
    expect(screen.getByRole('heading', { name: 'Different display title' })).toBeVisible();
    rerender(<AiWorkspaceRoot scope="terminal" view={null} />);
    expect(workspace()).not.toHaveAttribute('data-session-id');
  });

  it('preserves expanded tools and the draft after returning from tool details', async () => {
    const user = userEvent.setup();
    const base = agentView();
    const read = projectAgentChatNodes(readRecoveryCapture as readonly AgentSessionEvent[])
      .flatMap((node) => node.kind === 'turnProcess' ? node.children : [])
      .find((node) => node.kind === 'tool' && node.state === 'failed');
    if (read?.kind !== 'tool') throw new Error('Recorded read failure is missing');
    const view = {
      ...base,
      nodes: base.nodes.map((node) => node.kind === 'turnProcess' ? {
        ...node,
        sessionId: 'tool-details-return-test',
        children: [...node.children, { ...read, sessionId: base.summary.id }],
      } : node),
    };
    function DetailsWorkspace() {
      const [navigation, setNavigation] = useState(createAiWorkspaceNavigationState(view.summary.id));
      return (
        <AiWorkspaceRoot
          view={view}
          scope="terminal"
          defaultDraft="Unsent draft"
          navigation={navigation}
          onOpenTool={(node) => setNavigation({
            ...navigation,
            route: { kind: 'toolDetails', sessionId: node.sessionId, nodeKey: node.key },
          })}
          onBack={() => setNavigation({ ...navigation, route: { kind: 'conversation', sessionId: view.summary.id } })}
        />
      );
    }
    const { container } = render(<DetailsWorkspace />);
    const process = screen.getByRole('button', { name: 'Process complete' });
    if (process.getAttribute('aria-expanded') === 'false') await user.click(process);
    const tool = screen.getByRole('button', { name: /^Command:/u });
    await user.click(tool);
    const command = screen.getByRole('button', { name: 'Show full command' });
    await user.click(command);
    await user.click(screen.getByRole('button', { name: /^Read:/u }));
    await user.click(screen.getByRole('button', { name: `Open details for ${read.name}` }));
    const detail = container.querySelector('[data-slot="ai-tool-details"]');
    expect(detail).toBeVisible();
    expect(detail).toHaveTextContent(read.summary);
    expect(tool).not.toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(tool).toBeVisible();
    expect(tool).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Collapse command' })).toBe(command);
    expect(screen.getByTestId('ai-workspace-composer')).toHaveTextContent('Unsent draft');
    await user.click(tool);
    expect(tool).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the notice area hidden while stopping and preserves the draft', () => {
    const { container } = render(<AiWorkspaceRoot scope="terminal" view={agentView('running')}
      defaultDraft="Unsent draft"
      composerState={createAiComposerState({ phase: 'stopping', runtimeStatus: 'running', draft: 'Unsent draft' })} />);
    const notices = container.querySelector('[data-slot="ai-workspace-status-notices"]')!;
    expect(notices).toBeEmptyDOMElement();
    expect(notices).toHaveClass('empty:hidden');
    expect(screen.getByTestId('ai-workspace-composer')).toHaveTextContent('Unsent draft');
  });

  it.each(['waitingApproval', 'waitingQuestion'] as const)('places %s notices above the input inside the composer', (phase) => {
    const { container, rerender } = render(<AiWorkspaceRoot scope="terminal" view={agentView('running')}
      composerState={createAiComposerState({ phase, runtimeStatus: 'running' })} />);
    const notices = container.querySelector<HTMLElement>('[data-slot="ai-workspace-status-notices"]')!;
    const body = container.querySelector('[data-slot="ai-workspace-body"]')!;
    const composer = container.querySelector('[data-slot="ai-composer-seat"]')!;
    const alert = notices.querySelector('[data-slot="alert"]');
    expect(alert).toHaveAttribute('data-size', 'sm');
    expect(alert).toHaveClass('border-primary/30', 'bg-primary/10');
    expect(alert?.querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
    expect(notices).toHaveClass('gap-1.5');
    expect(body).toContainElement(notices);
    expect(composer).toContainElement(notices);
    expect(notices.compareDocumentPosition(composer.querySelector('[data-composer-card]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(<AiWorkspaceRoot scope="terminal" view={agentView('idle')}
      composerState={createAiComposerState({ phase: 'idle', runtimeStatus: 'idle' })} />);
    expect(notices).toBeEmptyDOMElement();
    expect(notices).toHaveClass('empty:hidden');
  });

  it('places history and availability notices above the input with a continuation action', () => {
    const { container } = render(<AiWorkspaceRoot scope="terminal" view={agentView('failed')}
      historicalContinuationAvailable historicalContinuationBusy historicalContinuationError="Connection lost"
      agentUnavailableReason="Connect a terminal" onContinueOnReconnectedTerminal={() => {}} />);
    const notices = container.querySelector('[data-slot="ai-workspace-status-notices"]') as HTMLElement;
    expect(within(notices).queryByText('Preparing the continued conversation…')).toBeNull();
    expect(within(notices).getByText('Connection lost')).toBeVisible();
    expect(within(notices).getByText('Connection lost').closest('[data-slot="alert"]'))
      .toHaveClass('border-destructive/20', 'bg-destructive/5');
    expect(within(notices).getByText('Connect a terminal').closest('[data-slot="alert"]'))
      .toHaveClass('border-primary/30', 'bg-primary/10');
    expect([...notices.querySelectorAll('[data-slot="alert"]')].every((alert) => alert.getAttribute('data-size') === 'sm'))
      .toBe(true);
    for (const notice of notices.querySelectorAll('[data-slot="alert"]')) {
      expect(notice.querySelectorAll(':scope > svg')).toHaveLength(1);
      expect(notice.querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
    }
    const availability = within(notices).getByRole('status', { name: 'Agent is unavailable' });
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-describedby', availability.id);
    const continuation = within(notices).getByRole('button', { name: 'Verify connection and continue' });
    expect(continuation).toBeVisible();
    expect(continuation.querySelector('svg')).toBeNull();
    expect(continuation).toHaveClass('h-6', 'text-[11px]');
    expect(continuation).not.toHaveClass('h-8');
  });

  it('shows the reconnect continuation action even without an unavailable error', async () => {
    const user = userEvent.setup();
    function ContinuedWorkspace() {
      const [continued, setContinued] = useState(false);
      return <>
        <AiWorkspaceRoot scope="terminal" view={agentView('failed')} readOnlySession
          onContinueOnReconnectedTerminal={() => setContinued(true)} />
        <output>{continued ? 'continued' : 'pending'}</output>
      </>;
    }
    const { container } = render(<ContinuedWorkspace />);
    const notices = container.querySelector<HTMLElement>('[data-slot="ai-workspace-status-notices"]')!;
    expect(within(notices).getByText('Your history and draft are preserved. Verify the current connection and execution state to continue this conversation. Earlier commands will not run automatically.')).toBeVisible();
    await user.click(within(notices).getByRole('button', { name: 'Verify connection and continue' }));
    expect(container.querySelector('output')).toHaveTextContent('continued');
  });

  it.each([
    ['reconnect', 'Reconnect terminal'],
    ['settings', 'Open AI settings'],
  ] as const)('invokes the %s action from the availability notice without changing the draft', async (action, label) => {
    const user = userEvent.setup();
    function AvailabilityWorkspace() {
      const [result, setResult] = useState('pending');
      return <>
        <AiWorkspaceRoot scope="terminal" view={null} agentUnavailableReason="Unavailable"
          canStartAgent={action === 'settings'} defaultDraft="Unsent message"
          onReconnectTerminal={action === 'reconnect' ? () => setResult('reconnected') : undefined}
          onOpenModel={action === 'settings' ? () => setResult('settings opened') : undefined} />
        <output>{result}</output>
      </>;
    }
    const { container } = render(<AvailabilityWorkspace />);
    const notices = container.querySelector<HTMLElement>('[data-slot="ai-workspace-status-notices"]')!;
    expect(within(notices).getByRole('button', { name: label })).toHaveClass('h-6', 'text-[11px]');
    expect(within(notices).getByRole('button', { name: label })).not.toHaveClass('h-8');
    await user.click(within(notices).getByRole('button', { name: label }));
    expect(container.querySelector('output')).toHaveTextContent(action === 'reconnect' ? 'reconnected' : 'settings opened');
    expect(screen.getByRole('textbox')).toHaveTextContent('Unsent message');
  });

  it('removes and restores icon inset with the reconnect action while preserving the notice and draft', async () => {
    const user = userEvent.setup();
    const props = { scope: 'terminal' as const, view: null, agentUnavailableReason: 'Connect a terminal',
      defaultDraft: 'Unsent message' };
    const reconnect = () => rerender(<AiWorkspaceRoot {...props} />);
    const { rerender } = render(<AiWorkspaceRoot {...props} onReconnectTerminal={reconnect} />);
    const notice = screen.getByRole('status', { name: 'Agent is unavailable' });
    const text = within(notice).getByText('Connect a terminal');
    expect(notice).toHaveClass('[--alert-icon-inset:--spacing(1)]');
    expect(text).toHaveClass('py-1');

    await user.click(within(notice).getByRole('button', { name: 'Reconnect terminal' }));
    expect(screen.getByRole('status', { name: 'Agent is unavailable' })).toBe(notice);
    expect(within(notice).queryByRole('button')).toBeNull();
    expect(notice).not.toHaveClass('[--alert-icon-inset:--spacing(1)]');
    expect(notice).toHaveClass('[--alert-icon-inset:0px]');
    expect(text).not.toHaveClass('py-1');

    rerender(<AiWorkspaceRoot {...props} onReconnectTerminal={reconnect} />);
    expect(screen.getByRole('status', { name: 'Agent is unavailable' })).toBe(notice);
    expect(within(notice).getByRole('button', { name: 'Reconnect terminal' })).toBeVisible();
    expect(notice).toHaveClass('[--alert-icon-inset:--spacing(1)]');
    expect(text).toHaveClass('py-1');
    expect(screen.getByRole('textbox')).toHaveTextContent('Unsent message');
  });

  it('does not offer a continue task button after a step budget pause', () => {
    const view = agentView('idle');
    const nodes = view.nodes.map(node => node.kind === 'turnTail'
      ? { ...node, endReason: 'stepBudgetReached: maximum 128 Steps per Turn' } : node);
    expect(nodes.some(node => node.kind === 'turnTail')).toBe(true);
    render(<AiWorkspaceRoot scope="terminal" view={{ ...view, nodes }} />);
    expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull();
  });

  it.each([
    ['en-US', 'This task reached its cumulative model token limit', 'Continue task', 'Task continuation summary'],
    ['zh-CN', '本任务已达到累计模型用量上限', '继续任务', '任务续跑摘要'],
  ] as const)('renders the persisted token failure without action buttons in %s', async (locale, title, action, artifact) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { container, rerender } = render(<AiWorkspaceRoot scope="workbench" mode="ask" view={taskTokenBudgetView()} canStartAgent />);
    const error = container.querySelector('.ai-turn-error') as HTMLElement;
    expect(error).not.toBeNull();
    expect(within(error).getByText(title)).toBeVisible();
    expect(error).not.toHaveTextContent('taskTokenBudgetExceeded:');
    expect(screen.queryByText(artifact)).toBeNull();
    expect(screen.queryByRole('button', { name: locale === 'zh-CN' ? '运行记录' : 'Run records' })).toBeNull();
    expect(container.querySelector('[data-token-budget-notice]')).not.toBeNull();
    const notice = container.querySelector('[data-token-budget-notice]') as HTMLElement;
    expect(within(notice).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    expect(screen.getByRole('textbox')).toBeEnabled();
    rerender(<AiWorkspaceRoot scope="workbench" mode="ask" view={taskTokenBudgetView(true)} canStartAgent />);
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    expect(container.querySelector('[data-token-budget-notice]')).toBeNull();
    expect(within(error).getByText(title)).toBeVisible();
  });

  it('does not offer continuation for archived or child sessions', () => {
    const view = taskTokenBudgetView();
    const { rerender } = render(<AiWorkspaceRoot scope="workbench" view={{ ...view,
      summary: { ...view.summary, archived: true } }} canStartAgent />);
    expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull();
    rerender(<AiWorkspaceRoot scope="workbench" view={{ ...view, snapshot: { kind: 'agent', value: {
      ...view.snapshot.value, header: { ...view.snapshot.value.header, parentSessionId: 'parent' },
    } } }} canStartAgent />);
    expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull();
  });

  it('does not show a live waiting indicator for a read-only historical session', () => {
    const view = { ...agentView('waiting'), statusReason: 'waitingForNetwork' };
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="terminal" />,
    );

    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent('Waiting for network recovery');
    rerender(<AiWorkspaceRoot view={view} scope="terminal" readOnlySession historicalTargetUnavailable />);
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    expect(screen.getByText('Check nginx now.')).toBeVisible();
  });

  it.each([
    ['en-US', 'Loading conversation…'],
    ['zh-CN', '正在加载历史会话…'],
  ] as const)('shows localized loading feedback and preserves the layout in %s', async (locale, label) => {
    await initI18n(locale);
    const view = agentView();
    const navigation = createAiWorkspaceNavigationState(view.summary.id);
    const { container, rerender } = render(
      <AiWorkspaceRoot view={null} scope="workbench" navigation={navigation} sessions={[view.summary]} />,
    );
    const composer = screen.getByTestId('ai-workspace-composer');

    expect(container.querySelector('[data-slot="ai-workspace-root"]')).toHaveAttribute('data-phase', 'active');
    expect(container.querySelector('[data-slot="ai-empty-hero"]')).toBeNull();
    expect(screen.getByRole('heading', { name: view.summary.title })).toBeVisible();
    expect(container.querySelector('[data-slot="ai-workspace-content"]')).toHaveAttribute('aria-busy', 'true');
    const loading = screen.getByText(label).closest('[role="status"]');
    expect(loading).toBeVisible();
    expect(loading).toHaveAttribute('aria-live', 'polite');
    expect(loading).toHaveClass('min-h-0', 'flex-1');
    expect(loading?.querySelector('[data-slot="spinner"]')).toHaveAttribute('aria-hidden', 'true');
    // Mount the scroller only with the transcript so its initial anchor is available.
    expect(container.querySelector('[data-message-scroller-viewport]')).toBeNull();

    rerender(<AiWorkspaceRoot view={view} scope="workbench" navigation={navigation} sessions={[view.summary]} />);
    expect(container.querySelector('[data-slot="ai-workspace-root"]')).toHaveAttribute('data-phase', 'active');
    expect(screen.getByTestId('ai-workspace-composer')).toBe(composer);
    await waitFor(() => expect(screen.getByText('Check nginx now.')).toBeVisible());
    expect(container.querySelector('[data-slot="ai-workspace-content"]')).not.toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(label)).toBeNull();
  });

  it('places dismissible operation errors above the input inside the composer', async () => {
    const user = userEvent.setup();
    const error = {
      kind: 'unknown' as const,
      message: 'Committed Agent event 56 changed after publication',
      retryable: true,
    };

    function ErrorWorkspace(): React.ReactNode {
      const [composerState, setComposerState] = useState(createAiComposerState({
        phase: 'error',
        draft: 'new input',
        lastError: error,
      }));
      return (
        <AiWorkspaceRoot
          view={null}
          scope="workbench"
          composerState={composerState}
          agentUnavailableReason="INVALID_MODEL_SELECTION: route-8e7d5ff7-25b5-4526-a8fa-df932c19228c/k3"
          onDismissError={() => setComposerState((current) => ({ ...current, lastError: null }))}
        />
      );
    }

    const { container } = render(<ErrorWorkspace />);
    const header = container.querySelector<HTMLElement>('[data-slot="ai-workspace-header"]');
    const notices = container.querySelector<HTMLElement>('[data-slot="ai-workspace-error-notices"]');
    const body = container.querySelector<HTMLElement>('[data-slot="ai-workspace-body"]');
    const composer = container.querySelector<HTMLElement>('[data-slot="ai-composer-seat"]');
    if (!header || !notices || !body || !composer) throw new Error('Expected the complete workspace layout');

    expect(notices).toBeVisible();
    expect(header.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body).toContainElement(notices);
    expect(composer).toContainElement(notices);
    expect(notices.compareDocumentPosition(composer.querySelector('[data-composer-card]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const operationError = screen.getByText(error.message).closest('[role="alert"]');
    expect(operationError).toHaveAttribute('data-size', 'sm');
    const availabilityNotice = screen.getByText(/The current model configuration/).closest('[role="status"]');
    expect(availabilityNotice).toHaveAttribute('data-size', 'sm');
    const dismiss = screen.getByRole('button', { name: 'Dismiss error' });
    const description = operationError?.querySelector('[data-slot="alert-description"]');
    expect(description).toHaveClass('flex-wrap', 'items-start', 'justify-end');
    expect(description).toContainElement(dismiss);
    expect(dismiss).toHaveTextContent('Dismiss error');
    expect(dismiss.querySelector('svg')).toBeNull();
    expect(operationError).toHaveClass('bg-destructive/5', 'items-center');
    expect(screen.getAllByText('Action failed')[0]).toHaveClass('sr-only');
    expect(screen.getByRole('textbox').textContent).toBe('new input');

    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByRole('textbox').textContent).toBe('new input');

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText(error.message)).toBeNull();
  });

  it('opens history over the conversation and preserves its draft and expanded process when dismissed', async () => {
    const user = userEvent.setup();
    const base = agentView();
    const view = {
      ...base,
      nodes: base.nodes.map((node) => node.kind === 'turnProcess' ? { ...node, sessionId: 'history-overlay-test' } : node),
    };
    const onOpen = vi.fn();
    function HistoryWorkspace(): React.ReactNode {
      const [navigation, setNavigation] = useState(createAiWorkspaceNavigationState(view.summary.id));
      const closeHistory = () => setNavigation(createAiWorkspaceNavigationState(view.summary.id));
      return (
        <AiWorkspaceRoot
          view={view}
          scope="workbench"
          defaultDraft="Unsent draft"
          navigation={navigation}
          sessions={[view.summary]}
          onHistory={() => setNavigation({ ...navigation, route: { kind: 'sessions' } })}
          onBack={closeHistory}
          onOpenSession={(summary) => { onOpen(summary); closeHistory(); }}
        />
      );
    }
    const { container } = render(<HistoryWorkspace />);
    const composer = screen.getByTestId('ai-workspace-composer');
    const conversation = container.querySelector('[data-message-scroller-viewport]');
    const history = screen.getByRole('button', { name: 'Conversation history' });
    const process = screen.getByRole('button', { name: 'Process complete' });
    if (process.getAttribute('aria-expanded') === 'false') await user.click(process);
    await user.click(history);

    const popover = await screen.findByRole('dialog', { name: 'Session history' });
    expect(popover).toContainElement(screen.getByRole('searchbox', { name: 'Search sessions' }));
    expect(container.querySelector('[data-message-scroller-viewport]')).toBe(conversation);
    expect(screen.getByTestId('ai-workspace-composer')).toBe(composer);
    expect(composer).toHaveTextContent('Unsent draft');
    expect(screen.getByRole('button', { name: 'Process complete' })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.ai-route-header')).toBeNull();
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Filter sessions' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(3);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(popover).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(history).toHaveFocus();
    expect(screen.getByTestId('ai-workspace-composer')).toBe(composer);

    await user.click(history);
    await user.type(screen.getByRole('searchbox'), 'nginx');
    await user.click(screen.getByRole('button', { name: /Check nginx and report evidence.*Completed/ }));
    expect(onOpen).toHaveBeenCalledWith(view.summary);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(history);
    await user.click(history);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(history);
    await user.click(composer);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(composer).toHaveTextContent('Unsent draft');
  });

  it('exposes subagents via the docked strip and inline delegation cards without crowding the root header', async () => {
    const user = userEvent.setup();
    const base = agentView('running');
    const child = {
      id: 'session-child',
      kind: 'agent' as const,
      title: 'Inspect the existing page',
      updatedAt: '2026-09-02T08:00:03.000Z',
      status: 'running' as const,
      scopeKey: base.summary.scopeKey,
      parentSessionId: base.summary.id,
      subagent: {
        descriptorId: 'descriptor-child',
        role: 'explorer' as const,
        continuable: false,
        depth: 1,
      },
      archived: false,
    };
    const spawnTool = {
      kind: 'tool' as const,
      key: 'tool:spawn-child',
      sourceKind: 'agent' as const,
      sessionId: base.summary.id,
      turnId: 'turn-01',
      stepId: 'step-01',
      firstSeq: 999,
      lastSeq: 999,
      timestamp: '2026-09-02T08:00:03.000Z',
      callId: 'call-spawn-child',
      name: 'spawn_one_shot_agent',
      nativeName: 'spawn_one_shot_agent',
      title: 'Agent orchestration',
      summary: '',
      state: 'running' as const,
      effect: 'readOnly' as const,
      durationMs: null,
      detailRef: { kind: 'agentTool' as const, sessionId: base.summary.id, callId: 'call-spawn-child' },
      evidenceRefs: [],
      input: {
        goal: 'Inspect the existing page\nCheck header layout',
        role: 'explorer',
        inheritanceMode: 'safePrefix',
        targetIds: [base.summary.scopeKey],
      },
      output: { childSessionId: child.id },
      error: null,
      target: null,
      idempotency: null,
      approval: null,
    };
    const view: AiSessionView = {
      ...base,
      nodes: [...base.nodes, spawnTool],
      subagents: [{
        sessionId: child.id,
        parentSessionId: base.summary.id,
        descriptorId: child.subagent.descriptorId,
        role: child.subagent.role,
        continuable: child.subagent.continuable,
        depth: child.subagent.depth,
        status: 'running',
      }],
    };
    const onOpen = vi.fn();
    const { container } = render(
      <AiWorkspaceRoot
        view={view}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child]}
        onOpenSession={onOpen}
      />,
    );

    const header = container.querySelector('[data-slot="ai-workspace-header"]') as HTMLElement;
    expect(within(header).queryByRole('button', { name: /subagent/i })).toBeNull();

    const strip = container.querySelector('[data-slot="ai-subagent-strip"]') as HTMLElement;
    expect(strip).toBeVisible();
    const stripTrigger = within(strip).getByRole('button', { name: 'Toggle 1 subagents' });
    expect(stripTrigger.querySelector('.ai-session-status-dot')).toBeNull();
    expect(stripTrigger).toHaveTextContent('Subagents');
    expect(stripTrigger).toHaveTextContent('1 running');
    await user.click(stripTrigger);
    expect(within(strip).getByText('Inspect the existing page')).toBeVisible();
    expect(within(strip).getByText('Explorer')).toBeVisible();
    expect(within(strip).getByText('One-shot · In progress')).toBeVisible();

    await user.click(within(strip).getByRole('button', {
      name: 'Open subagent “Inspect the existing page”: Explorer, One-shot, In progress',
    }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: child.id }));

    const card = container.querySelector('[data-slot="ai-subagent-card"]') as HTMLElement;
    expect(card).toBeVisible();
    expect(card).not.toHaveTextContent('Agent orchestration');
    const cardTitle = card.querySelector('.ai-subagent-card-title') as HTMLElement;
    const cardBadge = within(card).getByText('Explorer');
    expect(cardBadge).toHaveAttribute('data-variant', 'outline');
    expect(Boolean(cardTitle.compareDocumentPosition(cardBadge) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await user.click(within(card).getByRole('button', { name: 'Expand summary' }));
    expect(within(card).getByText(/Check header layout/)).toBeVisible();
    await user.click(within(card).getByRole('button', {
      name: 'Open subagent “Inspect the existing page”: Explorer, In progress',
    }));
    expect(onOpen).toHaveBeenCalledTimes(2);

    await act(async () => {
      useAppStore.setState({ locale: 'zh-CN' });
      await initI18n('zh-CN');
    });
    expect(strip).toHaveTextContent('1 运行中');
    expect(strip).not.toHaveTextContent('1 个运行中');
  });

  it('handles uncertain subagent cards, interactive vs static card states, readable inspect labels, and strip collapse on session switch', async () => {
    const user = userEvent.setup();
    const base = agentView('running');
    const child = {
      ...base.summary,
      id: 'session-child',
      title: 'Inspect child logs',
      parentSessionId: base.summary.id,
      subagent: {
        descriptorId: 'descriptor-child',
        role: 'explorer' as const,
        continuable: true,
        depth: 1,
      },
    };
    const grandchild = {
      ...base.summary,
      id: 'session-grandchild',
      title: 'Check TLS cert',
      parentSessionId: child.id,
      subagent: {
        descriptorId: 'descriptor-grandchild',
        role: 'verifier' as const,
        continuable: false,
        depth: 2,
      },
    };
    const uncertainCardNode = {
      kind: 'tool' as const,
      key: 'tool:uncertain-card',
      sourceKind: 'agent' as const,
      sessionId: base.summary.id,
      turnId: 'turn-01',
      stepId: 'step-01',
      firstSeq: 998,
      lastSeq: 998,
      timestamp: '2026-09-02T08:00:03.000Z',
      callId: 'call-uncertain',
      name: 'spawn_one_shot_agent',
      nativeName: 'spawn_one_shot_agent',
      title: 'Agent orchestration',
      summary: '',
      state: 'uncertain' as const,
      effect: 'readOnly' as const,
      durationMs: null,
      detailRef: { kind: 'agentTool' as const, sessionId: base.summary.id, callId: 'call-uncertain' },
      evidenceRefs: [],
      input: { role: 'diagnostician', goal: 'Probe remote service\nWith timeout details' },
      output: null,
      error: 'Outcome lost after disconnect',
      target: null,
      idempotency: null,
      approval: null,
    };
    const staticCardNode = {
      kind: 'tool' as const,
      key: 'tool:static-card',
      sourceKind: 'agent' as const,
      sessionId: base.summary.id,
      turnId: 'turn-01',
      stepId: 'step-02',
      firstSeq: 999,
      lastSeq: 999,
      timestamp: '2026-09-02T08:00:04.000Z',
      callId: 'call-static',
      name: 'spawn_one_shot_agent',
      nativeName: 'spawn_one_shot_agent',
      title: 'Agent orchestration',
      summary: '',
      state: 'preparing' as const,
      effect: 'readOnly' as const,
      durationMs: null,
      detailRef: { kind: 'agentTool' as const, sessionId: base.summary.id, callId: 'call-static' },
      evidenceRefs: [],
      input: { role: 'operator', goal: 'Preparing target check' },
      output: null,
      error: null,
      target: null,
      idempotency: null,
      approval: null,
    };
    const onOpenTool = vi.fn();
    const { container, rerender } = render(
      <AiWorkspaceRoot
        view={{
          ...base,
          nodes: [...base.nodes, uncertainCardNode, staticCardNode],
          subagents: [{
            sessionId: child.id,
            parentSessionId: base.summary.id,
            descriptorId: child.subagent.descriptorId,
            role: child.subagent.role,
            continuable: child.subagent.continuable,
            depth: child.subagent.depth,
            status: 'running',
          }],
        }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={vi.fn()}
        onOpenTool={onOpenTool}
      />,
    );

    const cards = container.querySelectorAll<HTMLElement>('[data-slot="ai-subagent-card"]');
    expect(cards).toHaveLength(2);
    const [uncertainCard, staticCard] = [cards[0]!, cards[1]!];

    expect(uncertainCard).toHaveAttribute('data-state', 'uncertain');
    expect(uncertainCard).toHaveAttribute('data-clickable', 'true');
    expect(uncertainCard).not.toHaveAttribute('data-openable');
    expect(uncertainCard.querySelector('[data-status="uncertain"]')).not.toBeNull();
    expect(within(uncertainCard).getByText(/Execution outcome unknown/)).toBeVisible();

    const mainExpandButton = uncertainCard.querySelector<HTMLButtonElement>('.ai-subagent-card-main')!;
    expect(mainExpandButton.tagName).toBe('BUTTON');
    await user.click(mainExpandButton);
    expect(within(uncertainCard).getByText('Outcome lost after disconnect')).toBeVisible();
    await user.click(within(uncertainCard).getByRole('button', { name: 'Open details for Probe remote service' }));
    expect(onOpenTool).toHaveBeenCalledWith(uncertainCardNode);

    expect(staticCard).toHaveAttribute('data-clickable', 'true');
    expect(staticCard).not.toHaveAttribute('data-openable');

    rerender(
      <AiWorkspaceRoot
        view={{
          ...base,
          nodes: [...base.nodes, staticCardNode],
          subagents: [],
        }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary]}
        onOpenSession={vi.fn()}
      />,
    );
    const nonInteractiveCard = container.querySelector<HTMLElement>('[data-slot="ai-subagent-card"]')!;
    expect(nonInteractiveCard).not.toHaveAttribute('data-clickable');
    expect(nonInteractiveCard).not.toHaveAttribute('data-openable');
    expect(nonInteractiveCard.querySelector('.ai-subagent-card-main')?.tagName).toBe('DIV');

    rerender(
      <AiWorkspaceRoot
        view={{
          ...base,
          nodes: [...base.nodes, uncertainCardNode, staticCardNode],
          subagents: [{
            sessionId: child.id,
            parentSessionId: base.summary.id,
            descriptorId: child.subagent.descriptorId,
            role: child.subagent.role,
            continuable: child.subagent.continuable,
            depth: child.subagent.depth,
            status: 'running',
          }],
        }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={vi.fn()}
        onOpenTool={onOpenTool}
      />,
    );

    const rootStrip = container.querySelector('[data-slot="ai-subagent-strip"]') as HTMLElement;
    const rootTrigger = rootStrip.querySelector('.ai-subagent-strip-trigger') as HTMLButtonElement;
    expect(rootTrigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(rootTrigger);
    expect(rootTrigger).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <AiWorkspaceRoot
        view={{
          ...base,
          summary: child,
          subagents: [{
            sessionId: grandchild.id,
            parentSessionId: child.id,
            descriptorId: grandchild.subagent.descriptorId,
            role: grandchild.subagent.role,
            continuable: grandchild.subagent.continuable,
            depth: grandchild.subagent.depth,
            status: 'waiting',
          }],
        }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={vi.fn()}
        onOpenTool={onOpenTool}
      />,
    );

    const childStripTrigger = container.querySelector('.ai-subagent-strip-trigger') as HTMLButtonElement;
    expect(childStripTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('counts nested descendants in the strip and provides back + switcher navigation on child and grandchild subagents', async () => {
    const user = userEvent.setup();
    const base = agentView('running');
    const child = {
      ...base.summary,
      id: 'session-child',
      title: 'Inspect implementation',
      parentSessionId: base.summary.id,
      subagent: {
        descriptorId: 'descriptor-child',
        role: 'explorer',
        continuable: true,
        depth: 1,
      },
    };
    const grandchild = {
      ...base.summary,
      id: 'session-grandchild',
      title: 'Verify the result',
      parentSessionId: child.id,
      subagent: {
        descriptorId: 'descriptor-grandchild',
        role: 'verifier',
        continuable: false,
        depth: 2,
      },
    };
    const onOpen = vi.fn();
    const { container, rerender } = render(
      <AiWorkspaceRoot
        view={{
          ...base,
          subagents: [{
            sessionId: child.id,
            parentSessionId: base.summary.id,
            descriptorId: child.subagent.descriptorId,
            role: child.subagent.role,
            continuable: child.subagent.continuable,
            depth: child.subagent.depth,
            status: 'running',
          }],
        }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={onOpen}
      />,
    );

    const strip = container.querySelector('[data-slot="ai-subagent-strip"]') as HTMLElement;
    await user.click(within(strip).getByRole('button', { name: 'Toggle 2 subagents' }));
    expect(within(strip).getByText('Inspect implementation')).toBeVisible();
    expect(within(strip).getByText('Verify the result')).toBeVisible();

    rerender(
      <AiWorkspaceRoot
        view={{ ...base, summary: grandchild, subagents: [] }}
        scope="terminal"
        mode="agent"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={onOpen}
      />,
    );

    expect(container.querySelector('[data-slot="ai-subagent-strip"]')).toBeNull();
    const header = container.querySelector('[data-slot="ai-workspace-header"]') as HTMLElement;
    expect(header).toHaveAttribute('data-subagent-view', 'true');
    expect(within(header).getByText('Verifier')).toBeVisible();
    expect(within(header).getByText(/Check nginx and report evidence\. \/ Inspect implementation/)).toBeVisible();

    await user.click(within(header).getByRole('button', {
      name: 'Back to parent: Inspect implementation',
    }));
    expect(onOpen).toHaveBeenCalledWith(child);

    const switcher = within(header).getByRole('button', {
      name: 'Switch subagent, current: Verify the result',
    });
    expect(switcher).toBeVisible();
    expect(switcher).toHaveTextContent('2/2');
    await user.click(switcher);
    const leafCatalog = await screen.findByRole('dialog', { name: 'Session & subagents' });
    expect(within(leafCatalog).getByText('Current')).toBeVisible();
    await user.click(within(leafCatalog).getByRole('button', {
      name: 'Return to main session “Check nginx and report evidence.”',
    }));
    expect(onOpen).toHaveBeenCalledWith(base.summary);

    rerender(
      <AiWorkspaceRoot
        view={{
          ...base,
          summary: {
            ...grandchild,
            parentSessionId: 'missing-parent',
          },
          subagents: [],
        }}
        scope="terminal"
        mode="agent"
        sessions={[grandchild]}
        onHistory={vi.fn()}
        onNewSession={vi.fn()}
        canStartAgent
        onOpenSession={onOpen}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Back to / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Conversation history' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });

  it('keeps question submission visible briefly after a fast commit and preserves the composer draft', async () => {
    const base = agentView();
    const pendingQuestion: NonNullable<AiSessionView['pendingQuestion']> = {
      identity: { sessionId: 'session-fixture', turnId: 'turn-01', stepId: 'step-01', requestId: 'request-01', callId: 'q', questionRequestId: 'workspace-question' },
      questions: [{ id: 'text', question: 'What next?', multi_select: false }],
      answers: [], status: 'pending', firstSeq: 1, lastSeq: 1, timestamp: '2026-09-04T00:00:00Z',
    };
    const submitted: AnswerQuestionInput[] = [];
    const onAnswerQuestion = async (input: AnswerQuestionInput) => { submitted.push(input); };
    const onSubmit = vi.fn();
    const props = { scope: 'workbench' as const, canStartAgent: true, defaultDraft: 'ordinary unsent draft', onAnswerQuestion, onSubmit };
    const view = { ...base, pendingQuestion, status: 'waiting' as const };
    const { container, rerender } = render(<AiWorkspaceRoot {...props} view={view} />);
    expect(screen.getByRole('button', { name: 'Process complete' })).toHaveAttribute('aria-expanded', 'true');
    const panel = container.querySelector('[data-slot="ai-question-panel"]')!;
    expect(panel.closest('[data-ai-node-kind="turnProcess"]')).toBeNull();
    expect(container.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
    expect(screen.getByTestId('ai-workspace-composer').textContent).toBe('ordinary unsent draft');
    expect(screen.getByTestId('ai-workspace-composer')).toHaveAttribute('contenteditable', 'true');
    fireEvent.change(within(panel as HTMLElement).getByRole('textbox'), { target: { value: 'Continue' } });
    const button = screen.getByRole('button', { name: 'Submit' });
    fireEvent.click(button);
    expect(submitted.map((input) => input.answers)).toEqual([[{ id: 'text', selected: [], custom: 'Continue' }]]);
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<AiWorkspaceRoot {...props} view={{ ...base, pendingQuestion: null }} />);
    act(() => useAgentQuestionStore.getState().clear(questionKey(pendingQuestion.identity)));
    expect(panel).toBeVisible();
    expect(screen.getByRole('button', { name: 'Saving answers…' })).toBe(button);
    expect(button.querySelector('[data-slot="spinner"]')).toBeVisible();
    expect(button).toBeDisabled();
    expect(within(panel as HTMLElement).getByRole('textbox')).toHaveValue('Continue');
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    expect(submitted).toHaveLength(1);
    expect(screen.getByTestId('ai-workspace-composer').textContent).toBe('ordinary unsent draft');
    expect(screen.getByTestId('ai-workspace-composer')).toHaveAttribute('contenteditable', 'true');
  });
  it.each([320, 400, 560, 720])(
    'keeps the complete single-column workspace structure at %d px',
    (width) => {
      const { container } = render(
        <div style={{ width, height: 640 }}>
          <AiWorkspaceRoot
            view={agentView()}
            scope="workbench"
            providerLabel="Local provider"
            modelLabel="Model fixture"
            canStartAgent
            onClose={vi.fn()}
            onHistory={vi.fn()}
            onNewSession={vi.fn()}
            onSubmit={vi.fn()}
          />
        </div>,
      );

      const root = container.querySelector<HTMLElement>('[data-slot="ai-workspace-root"]');
      expect(root).toHaveClass('ai-workspace-root');
      expect(root).toHaveAttribute('data-phase', 'active');
      expect(screen.getByText('Check nginx now.')).toBeVisible();
      expect(root?.querySelector('[data-ai-node-kind="turnProcess"]')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Process complete' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('textbox')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Conversation history' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible();
      expect(root?.querySelector('.ai-composer-add')).toBeInTheDocument();
      expect(root?.querySelector('[data-slot="message-scroller"]'))
        .toContainElement(root?.querySelector('[data-message-scroller-viewport]') ?? null);
      expect(root?.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
      expect(root?.querySelectorAll('[data-slot="ai-workspace-content"] > aside')).toHaveLength(0);
    },
  );

  it('hides obsolete mode chrome and always routes visible new-session actions to Agent', async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn();
    const { container } = render(
        <AiWorkspaceRoot
          view={null}
          scope="terminal"
          canStartAgent
          onNewSession={onNewSession}
      />,
    );

    expect(screen.getByText('What would you like to accomplish?')).toBeVisible();
    expect(container.querySelector('.ai-session-context')).toHaveTextContent('Terminal');
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it('moves the resident composer from Hero to Active without losing DOM identity or focus', async () => {
    const user = userEvent.setup();
    const submitted: string[] = [];

    function Harness(): React.ReactNode {
      const [view, setView] = useState<AiSessionView | null>(null);
      return (
        <AiWorkspaceRoot
          view={view}
          scope="workbench"
          providerLabel="Local provider"
          modelLabel="Model fixture"
          onSubmit={({ content }) => {
            submitted.push(content);
            setView(agentView());
          }}
        />
      );
    }

    const { container } = render(<Harness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'keep local draft');
    textarea.focus();
    expect(container.querySelector('[data-slot="ai-workspace-root"]'))
      .toHaveAttribute('data-phase', 'hero');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(submitted).toEqual(['keep local draft']);
    expect(container.querySelector('[data-slot="ai-workspace-root"]'))
      .toHaveAttribute('data-phase', 'active');
    expect(screen.getByRole('textbox')).toBe(textarea);
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(screen.getByRole('textbox').textContent).toBe('keep local draft');
    expect(container.querySelector('[data-slot="ai-composer-seat"]'))
      .toHaveAttribute('data-phase', 'active');
  });

  it('keeps the process hierarchy and a trailing processing indicator while the session continues', () => {
    const view = runningHierarchyView();
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="workbench" />,
    );

    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(1);
    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent('Processing');
    expect(container.querySelectorAll('[data-ai-node-kind="turnProcess"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="reasoning"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-tool-state="running"]')).toHaveLength(0);

    const finalNode = view.nodes[view.nodes.length - 1]!;
    const appendedNode = {
      ...finalNode,
      key: 'test:additional-flow-node',
      lastSeq: finalNode.lastSeq + 1,
    };
    rerender(
      <AiWorkspaceRoot
        view={{ ...view, nodes: [...view.nodes, appendedNode] }}
        scope="workbench"
      />,
    );

    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(1);
    expect(container.querySelector('[data-ai-node-key="test:additional-flow-node"]')).toBeInTheDocument();
  });

  it('keeps a new user message unanchored and preserves its row on commit', async () => {
    const view = agentView('running');
    const previousUser = view.nodes.find((node) => node.kind === 'userMessage');
    if (!previousUser) throw new Error('Agent fixture has no user message');
    const nextUser = {
      ...previousUser,
      key: 'optimistic:next-submission',
      messageId: 'next-submission',
      clientSubmissionId: 'next-submission',
      content: 'Check the next service.',
    };
    const { container, rerender } = render(<AiWorkspaceRoot view={view} scope="terminal" />);
    const viewport = container.querySelector<HTMLElement>('[data-message-scroller-viewport]')!;
    let scrollTop = 100;
    const rect = (top: number) => ({
      top, bottom: top + 100, height: 100, left: 0, right: 320, width: 320,
      x: 0, y: top, toJSON: () => ({}),
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => { scrollTop = Number(top ?? 0); });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      scrollTo: { configurable: true, value: scrollTo },
      getBoundingClientRect: { configurable: true, value: () => rect(0) },
    });
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);

    rerender(<AiWorkspaceRoot view={{ ...view, nodes: [...view.nodes, nextUser] }} scope="terminal" />);
    const optimisticItem = container.querySelector(`[data-ai-node-key="${nextUser.key}"]`)
      ?.closest('[data-slot="message-scroller-item"]');
    expect(optimisticItem).toHaveAttribute('data-scroll-anchor', 'false');
    expect(optimisticItem).toHaveAttribute('data-message-id', 'user:next-submission');
    expect(container.querySelectorAll('[data-scroll-anchor="true"]')).toHaveLength(0);

    const committedUser = { ...nextUser, key: 'user:next-submission', clientSubmissionId: undefined, delivery: 'committed' as const };
    rerender(<AiWorkspaceRoot view={{ ...view, nodes: [...view.nodes, committedUser] }} scope="terminal" />);
    const committedItem = container.querySelector(`[data-ai-node-key="${committedUser.key}"]`)
      ?.closest('[data-slot="message-scroller-item"]');
    expect(committedItem).toBe(optimisticItem);
    expect(committedItem).toHaveAttribute('data-scroll-anchor', 'false');
    expect(committedItem).toHaveAttribute('data-message-id', 'user:next-submission');
  });

  it('keeps one collapsed reasoning row in Ask while hiding the full Agent process', async () => {
    const user = userEvent.setup();
    const view = {
      ...agentView(),
      nodes: projectAgentChatNodes(agentSessionBaselineScenarios.hello.events),
    };
    const { container } = render(
      <AiWorkspaceRoot view={view} scope="workbench" mode="ask" />,
    );

    const reasoning = screen.getByRole('button', { name: 'Thought' });
    expect(reasoning).toHaveAttribute('aria-expanded', 'false');
    expect(reasoning.querySelector('.lucide-brain')).toBeInTheDocument();
    expect(container.querySelector('[data-ai-node-kind="userMessage"]')?.closest('[data-slot="message-scroller-item"]'))
      .toHaveAttribute('data-scroll-anchor', 'false');
    expect(container.querySelector('[data-ai-node-kind="turnProcess"]')).toBeNull();
    const turnTail = container.querySelector('[data-ai-node-kind="turnTail"]');
    expect(turnTail).toBeInTheDocument();
    expect(turnTail?.closest('[data-slot="message-scroller-item"]')).toHaveClass('-ml-1.5');
    expect(turnTail?.querySelector('.ai-turn-tail')).not.toHaveClass('-ml-1.5');
    const footer = screen.getByLabelText('Turn statistics');
    expect(within(footer).getByRole('button', { name: 'Copy' })).toBeVisible();
    expect(within(footer).getByRole('button', { name: 'Usage 144 tok' })).toBeVisible();
    expect(within(footer).getByRole('button', { name: 'Time 1.1s' })).toBeVisible();
    expect(screen.queryByText('Read the frozen context. Answer directly.')).toBeNull();

    await user.click(within(footer).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('Hello! How can I help?');
    await user.click(reasoning);
    expect(reasoning).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Read the frozen context. Answer directly.')).toBeVisible();
  });

  it('keeps pasted image drafts available in Ask with the attachment menu', () => {
    const onPasteImages = vi.fn();
    render(
      <AiWorkspaceRoot
        view={null}
        scope="workbench"
        mode="ask"
        imageControls={<div data-testid="ask-image-draft">image preview</div>}
        onPasteImages={onPasteImages}
        hasImages
        onSubmitGesture={vi.fn()}
      />,
    );

    expect(screen.getByTestId('ask-image-draft')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add file or folder' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it.each(['agent', 'ask'] as const)('stops unfinished %s reasoning in read-only history without mutating live nodes', (mode) => {
    const view = {
      ...agentView('running'),
      nodes: projectAgentChatNodes(agentSessionBaselineScenarios['streaming-reasoning'].events),
    };
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="terminal" mode={mode} />,
    );
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    rerender(<AiWorkspaceRoot view={view} scope="terminal" mode={mode} readOnlySession historicalTargetUnavailable />);
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(screen.getByText('Thinking interrupted')).not.toHaveClass('shimmer');
    expect(container.querySelector('.ai-reasoning-row')).toHaveAttribute('data-state', 'interrupted');
    expect(container.querySelector('.ai-reasoning-row')).not.toHaveAttribute('role', 'status');
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    rerender(<AiWorkspaceRoot view={view} scope="terminal" mode={mode} />);
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it.each(['agent', 'ask'] as const)('preserves live %s reasoning in a read-only one-shot subagent', (mode) => {
    const base = agentView('running');
    const events = agentSessionBaselineScenarios['streaming-reasoning'].events;
    const view = {
      ...base,
      summary: {
        ...base.summary,
        subagent: { descriptorId: 'diagnostic', role: 'explorer' as const, continuable: false, depth: 1 },
      },
      nodes: projectAgentChatNodes(events.slice(0, -1)),
    };
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="terminal" mode={mode} readOnlySession />,
    );
    expect(screen.getByText('Thinking…')).toHaveClass('shimmer');
    rerender(<AiWorkspaceRoot view={{ ...view, nodes: projectAgentChatNodes(events) }}
      scope="terminal" mode={mode} readOnlySession />);
    expect(screen.getByText('Thinking…')).toHaveClass('shimmer');
    expect(screen.queryByText('Thinking interrupted')).toBeNull();
    expect(container.querySelector('.ai-reasoning-row')).toHaveAttribute('data-state', 'running');
    expect(container.querySelector('.ai-reasoning-row')).toHaveAttribute('role', 'status');
  });

  it('expands Ask reasoning while streaming and collapses it when thinking settles', () => {
    const base = agentView('running');
    const view = {
      ...base,
      nodes: projectAgentChatNodes(agentSessionBaselineScenarios['streaming-reasoning'].events),
      status: 'running' as const,
      summary: { ...base.summary, status: 'running' as const },
    };
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="workbench" mode="ask" />,
    );

    const thinking = screen.getByRole('button', { name: 'Thinking…' });
    expect(thinking).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.ai-reasoning-body'))
      .toHaveTextContent('Read the frozen context. Prepare a concise answer.');
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();

    const settledNodes = view.nodes.map((node) => node.kind === 'turnProcess' ? ({
      ...node,
      status: 'completed' as const,
      hasEndBoundary: true,
      children: node.children.map((child) => child.kind === 'reasoning'
        ? { ...child, state: 'completed' as const }
        : child),
    }) : node);
    rerender(
      <AiWorkspaceRoot
        view={{
          ...view,
          nodes: settledNodes,
          status: 'completed',
          summary: { ...view.summary, status: 'completed' },
        }}
        scope="workbench"
        mode="ask"
      />,
    );

    expect(screen.getByRole('button', { name: 'Thought' }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.ai-reasoning-body')).toBeNull();
  });

  it('shows immediate Ask feedback before the first model output arrives', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events)
      .filter((node) => node.kind === 'userMessage');
    const { container } = render(
      <AiWorkspaceRoot
        view={null}
        pendingNodes={nodes}
        composerState={createAiComposerState({ phase: 'submitting', runtimeStatus: 'idle' })}
        scope="workbench"
        mode="ask"
      />,
    );

    const thinkingIndicator = container.querySelector('[data-ai-thinking-indicator]');
    expect(thinkingIndicator).toHaveTextContent('Thinking…');
    expect(thinkingIndicator?.querySelector('.lucide-brain')).toBeInTheDocument();
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    expect(thinkingIndicator).not.toHaveTextContent('Processing');
  });

  it('renders Agent sessions through the conversation-only surface', () => {
    const view = agentView();
    expect(view.nodes.some((node) => node.kind === 'systemPrompt')).toBe(true);
    render(
      <AiWorkspaceRoot view={view} scope="terminal" />,
    );

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('log', { name: 'AI conversation' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'System prompt' })).toBeNull();
    expect(screen.getAllByText('Check nginx and report evidence.')).not.toHaveLength(0);

  });

  it('hides approved process markers when the Agent session has full access', async () => {
    const user = userEvent.setup();
    const base = agentView();
    const withPermission = (permissionMode: 'requestApproval' | 'operator'): AiSessionView => ({
      ...base,
      snapshot: {
        kind: 'agent',
        value: {
          ...base.snapshot.value,
          header: { ...base.snapshot.value.header, permissionMode },
        },
      },
    });
    const { container, rerender } = render(
      <AiWorkspaceRoot view={withPermission('requestApproval')} scope="terminal" />,
    );
    const process = screen.getByRole('button', { name: 'Process complete' });
    if (process.getAttribute('aria-expanded') === 'false') await user.click(process);

    expect(container.querySelectorAll('[data-ai-process-child="approvalMarker"]')).toHaveLength(1);
    expect(container.querySelector('[data-ai-process-child="approvalMarker"] .ai-transcript-notice'))
      .toHaveClass('items-center', 'gap-0');
    expect(container.querySelector('[data-ai-process-child="approvalMarker"] .ai-disclosure-leading'))
      .toHaveClass('mr-1');

    rerender(<AiWorkspaceRoot view={withPermission('operator')} scope="terminal" />);

    expect(container.querySelector('[data-ai-process-child="approvalMarker"]')).toBeNull();
  });

  it('keeps the Agent conversation mounted before the first running node commits', async () => {
    const view = agentView();
    render(
      <AiWorkspaceRoot
        view={{
          ...view,
          nodes: [],
          status: 'running',
          summary: { ...view.summary, status: 'running' },
        }}
        scope="terminal"
      />,
    );

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('log', { name: 'AI conversation' })).toBeVisible();
    expect(screen.getByText('Processing')).toBeVisible();
  });

  it('gives every icon-only workspace action an accessible name and tooltip', () => {
    const { container } = render(
      <AiWorkspaceRoot
        view={agentView()}
        scope="workbench"
        canStartAgent
        onClose={vi.fn()}
        onHistory={vi.fn()}
        onNewSession={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    for (const name of [
      'Conversation history',
      'New conversation',
      'Close AI assistant',
      'Send',
      'Scroll to latest message',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[data-base-ui-tooltip-trigger]').length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector('.ai-composer-add')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Conversation history' })).queryByText(/./))
      .toBeNull();
  });
});

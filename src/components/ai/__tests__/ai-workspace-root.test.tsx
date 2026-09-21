import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { createAiWorkspaceNavigationState } from '@/lib/ai/panel-route';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';

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

describe('AiWorkspaceRoot Phase 3 skeleton', () => {
  it.each(['stopping', 'waitingApproval', 'waitingQuestion'] as const)('places %s notices above the conversation instead of beside the composer', (phase) => {
    const { container, rerender } = render(<AiWorkspaceRoot scope="terminal" view={agentView('running')}
      composerState={createAiComposerState({ phase, runtimeStatus: 'running' })} />);
    const notices = container.querySelector('[data-slot="ai-workspace-status-notices"]')!;
    const body = container.querySelector('[data-slot="ai-workspace-body"]')!;
    const composer = container.querySelector('[data-slot="ai-composer-seat"]')!;
    const alert = notices.querySelector('[data-slot="alert"]');
    expect(alert).toHaveAttribute('data-size', 'sm');
    expect(alert).toHaveClass('border-primary/30', 'bg-primary/10');
    expect(alert?.querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
    expect(notices).toHaveClass('gap-1.5', 'py-2');
    expect(notices.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.querySelector('[data-slot="alert"]')).toBeNull();
    rerender(<AiWorkspaceRoot scope="terminal" view={agentView('idle')}
      composerState={createAiComposerState({ phase: 'idle', runtimeStatus: 'idle' })} />);
    expect(notices).toBeEmptyDOMElement();
    expect(notices).toHaveClass('empty:hidden');
  });

  it('places history and availability notices above the conversation with no continuation buttons', () => {
    const { container } = render(<AiWorkspaceRoot scope="terminal" view={agentView('failed')}
      historicalContinuationAvailable historicalContinuationBusy historicalContinuationError="Connection lost"
      agentUnavailableReason="Connect a terminal" onContinueOnReconnectedTerminal={() => {}} />);
    const notices = container.querySelector('[data-slot="ai-workspace-status-notices"]') as HTMLElement;
    expect(within(notices).getByText('Preparing the continued conversation…')).toBeVisible();
    expect(within(notices).getByText('Connection lost')).toBeVisible();
    expect(within(notices).getByText('Preparing the continued conversation…').closest('[data-slot="alert"]'))
      .toHaveClass('border-primary/30', 'bg-primary/10');
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
    expect(screen.queryByRole('button', { name: 'Continue in reconnected terminal' })).toBeNull();
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
    expect(screen.getByText(artifact)).toBeVisible();
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
    const view = agentView('waiting');
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="terminal" />,
    );

    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent('Waiting');
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

  it('places dismissible operation errors below the header instead of beside the composer', async () => {
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
        failedDrafts: [{ id: 'failed-1', content: 'failed input', mode: 'nextTurn', error }],
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
    expect(notices.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer).not.toContainElement(notices);
    const operationError = screen.getByText(error.message).closest('[role="alert"]');
    expect(operationError).toHaveAttribute('data-size', 'sm');
    const availabilityNotice = screen.getByText(/The current model configuration/).closest('[role="status"]');
    expect(availabilityNotice).toHaveAttribute('data-size', 'sm');
    const dismiss = screen.getByRole('button', { name: 'Dismiss error' });
    expect(dismiss.closest('[data-slot="alert-action"]')).toHaveClass('absolute', 'top-1/2', '-translate-y-1/2');
    expect(operationError?.querySelector('[data-slot="alert-description"]')).not.toContainElement(dismiss);
    expect(operationError).toHaveClass('bg-destructive/5', 'items-center');
    expect(screen.getAllByText('Action failed')[0]).toHaveClass('sr-only');
    expect(screen.getByRole('textbox').textContent).toBe('new input');

    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByRole('textbox').textContent).toBe('new input');

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText(error.message)).toBeNull();
    expect(screen.getByText('failed input')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Process complete' }));
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

  it('shows live subagent information in the header and opens the child transcript', async () => {
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
    const view: AiSessionView = {
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
    };
    const onOpen = vi.fn();
    render(
      <AiWorkspaceRoot
        view={view}
        scope="workbench"
        sessions={[base.summary, child]}
        onOpenSession={onOpen}
      />,
    );

    const trigger = screen.getByRole('button', { name: '1 subagent, 1 running' });
    expect(trigger).toBeVisible();
    await user.click(trigger);
    const catalog = await screen.findByRole('dialog', { name: 'Subagent sessions' });
    expect(within(catalog).getByText('Inspect the existing page')).toBeVisible();
    expect(within(catalog).getByText('Explorer')).toBeVisible();
    expect(within(catalog).getByText('One-shot · In progress')).toBeVisible();

    await user.click(within(catalog).getByRole('button', {
      name: 'Open subagent “Inspect the existing page”: Explorer, One-shot, In progress',
    }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: child.id }));
  });

  it('counts nested descendants and keeps lineage navigation on a leaf subagent', async () => {
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
    const { rerender } = render(
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
        scope="workbench"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={onOpen}
      />,
    );

    await user.click(screen.getByRole('button', { name: '2 subagents, 2 running' }));
    const catalog = await screen.findByRole('dialog', { name: 'Subagent sessions' });
    expect(within(catalog).getByText('Inspect implementation')).toBeVisible();
    expect(within(catalog).getByText('Verify the result')).toBeVisible();
    await user.keyboard('{Escape}');

    rerender(
      <AiWorkspaceRoot
        view={{ ...base, summary: grandchild, subagents: [] }}
        scope="workbench"
        sessions={[base.summary, child, grandchild]}
        onOpenSession={onOpen}
      />,
    );
    const lineage = screen.getByRole('button', { name: 'View the lineage of subagent “Verify the result”' });
    expect(lineage).toBeVisible();
    await user.click(lineage);
    const leafCatalog = await screen.findByRole('dialog', { name: 'Subagent sessions' });
    expect(within(leafCatalog).getByText('Current')).toBeVisible();
    await user.click(within(leafCatalog).getByRole('button', {
      name: 'Open root session “Check nginx and report evidence.”',
    }));
    expect(onOpen).toHaveBeenCalledWith(base.summary);
  });

  it('keeps the stage6a question actionable outside collapsed process and preserves ordinary draft', async () => {
    const base = agentView();
    const pendingQuestion: NonNullable<AiSessionView['pendingQuestion']> = {
      identity: { sessionId: 'session-fixture', turnId: 'turn-01', stepId: 'step-01', requestId: 'request-01', callId: 'q', questionRequestId: 'workspace-question' },
      questions: [{ id: 'text', question: 'What next?', multi_select: false }],
      answers: [], status: 'pending', firstSeq: 1, lastSeq: 1, timestamp: '2026-09-04T00:00:00Z',
    };
    const onAnswerQuestion = vi.fn(async () => undefined);
    const onSubmit = vi.fn();
    const props = { scope: 'workbench' as const, canStartAgent: true, defaultDraft: 'ordinary unsent draft', onAnswerQuestion, onSubmit };
    const view = { ...base, pendingQuestion, status: 'waiting' as const };
    const { container, rerender } = render(<AiWorkspaceRoot {...props} view={view} />);
    expect(screen.getByRole('button', { name: 'Process complete' })).toHaveAttribute('aria-expanded', 'false');
    const panel = container.querySelector('[data-slot="ai-question-panel"]')!;
    expect(panel.closest('[data-ai-node-kind="turnProcess"]')).toBeNull();
    expect(container.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
    expect(screen.getByTestId('ai-workspace-composer').textContent).toBe('ordinary unsent draft');
    expect(screen.getByTestId('ai-workspace-composer')).toHaveAttribute('contenteditable', 'true');
    fireEvent.change(within(panel as HTMLElement).getByRole('textbox'), { target: { value: 'Continue' } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onAnswerQuestion).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<AiWorkspaceRoot {...props} view={{ ...base, pendingQuestion: null }} />);
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
      expect(screen.getByRole('button', { name: 'Process complete' })).toHaveAttribute('aria-expanded', 'false');
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

  it('shows one Turn-level running indicator without exposing process children as top-level rows', () => {
    const view = runningHierarchyView();
    const { container, rerender } = render(
      <AiWorkspaceRoot view={view} scope="workbench" />,
    );

    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="turnProcess"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="reasoning"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-tool-state="running"]')).toHaveLength(0);
    const runningIndicator = container.querySelector('[data-ai-running-indicator]');
    expect(runningIndicator).toHaveTextContent('Working…');
    expect(runningIndicator?.querySelector('[data-slot="marker-icon"]')).toBeNull();
    expect(runningIndicator?.querySelector('[data-slot="marker-content"]')).toHaveClass('shimmer');

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
    expect(container.querySelector('[data-ai-running-indicator]')?.closest('[data-slot="message-scroller-item"]'))
      .toContainElement(container.querySelector('[data-ai-node-key="test:additional-flow-node"]'));
  });

  it('anchors a new user message and preserves its row on commit', async () => {
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
    expect(optimisticItem).toHaveAttribute('data-scroll-anchor', 'true');
    expect(optimisticItem).toHaveAttribute('data-message-id', 'user:next-submission');
    // Browser coverage checks actual top alignment and spacer geometry.
    expect(container.querySelectorAll('[data-scroll-anchor="true"]')).toHaveLength(1);

    const committedUser = { ...nextUser, key: 'user:next-submission', clientSubmissionId: undefined, delivery: 'committed' as const };
    rerender(<AiWorkspaceRoot view={{ ...view, nodes: [...view.nodes, committedUser] }} scope="terminal" />);
    const committedItem = container.querySelector(`[data-ai-node-key="${committedUser.key}"]`)
      ?.closest('[data-slot="message-scroller-item"]');
    expect(committedItem).toBe(optimisticItem);
    expect(committedItem).toHaveAttribute('data-scroll-anchor', 'true');
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
      .toHaveAttribute('data-scroll-anchor', 'true');
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
    expect(screen.queryByText('Working…')).toBeNull();

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
    expect(screen.queryByText('Working…')).toBeNull();
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Working…'));
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

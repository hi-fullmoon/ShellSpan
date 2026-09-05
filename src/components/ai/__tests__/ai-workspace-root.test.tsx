import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';

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
    expect(screen.getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'false');
    const panel = container.querySelector('[data-slot="ai-question-panel"]')!;
    expect(panel.closest('[data-ai-node-kind="turnProcess"]')).toBeNull();
    expect(container.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
    expect(screen.getByTestId('ai-workspace-composer').textContent).toBe('ordinary unsent draft');
    expect(screen.getByTestId('ai-workspace-composer')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(within(panel as HTMLElement).getByRole('textbox'), { target: { value: 'Continue' } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
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
      expect(screen.getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('textbox')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Conversation history' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible();
      expect(root?.querySelector('.ai-composer-add')).toBeNull();
      expect(root?.querySelector('[data-slot="message-scroller"]'))
        .toContainElement(root?.querySelector('[data-message-scroller-viewport]') ?? null);
      expect(root?.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
      expect(root?.querySelectorAll('[data-slot="ai-workspace-content"] > aside')).toHaveLength(0);
    },
  );

  it('hides legacy mode chrome and always routes visible new-session actions to Agent', async () => {
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

    expect(screen.getByText('How can I help?')).toBeVisible();
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
    const { container } = render(
      <AiWorkspaceRoot view={runningHierarchyView()} scope="workbench" />,
    );

    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="turnProcess"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="reasoning"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-tool-state="running"]')).toHaveLength(0);
    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent('Working…');
  });

  it('renders Agent sessions through the conversation-only surface', () => {
    const view = agentView();
    render(
      <AiWorkspaceRoot view={view} scope="terminal" />,
    );

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('log', { name: 'AI conversation' })).toBeVisible();
    expect(screen.getAllByText('Check nginx and report evidence.')).not.toHaveLength(0);

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
    expect(container.querySelector('.ai-composer-add')).toBeNull();
    expect(within(screen.getByRole('button', { name: 'Conversation history' })).queryByText(/./))
      .toBeNull();
  });
});

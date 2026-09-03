import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { projectAgentConversationNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';

function runningHierarchyView(): AiSessionView {
  const base = agentView('running');
  const user = base.nodes.find((node) => node.kind === 'userMessage');
  const assistant = base.nodes.find((node) => node.kind === 'assistantMessage');
  if (!user || !assistant) throw new Error('Agent fixture must project conversation nodes');
  const nodes: readonly AiConversationNode[] = [
    user,
    {
      kind: 'reasoning',
      key: 'reasoning:turn-1:step-1',
      sourceKind: 'agent',
      sessionId: base.summary.id,
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 3,
      lastSeq: 3,
      timestamp: base.summary.updatedAt,
      requestId: 'request-1',
      summary: 'Checked the deployment state',
      content: 'Checked the deployment state and selected the next safe read.',
      state: 'streaming',
    },
    {
      kind: 'tool',
      key: 'tool:call-1',
      sourceKind: 'agent',
      sessionId: base.summary.id,
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 4,
      lastSeq: 4,
      timestamp: base.summary.updatedAt,
      callId: 'call-1',
      name: 'terminal.read',
      summary: 'Read nginx status',
      state: 'running',
      effect: 'readOnly',
      durationMs: null,
      detailRef: { kind: 'agentTool', sessionId: base.summary.id, callId: 'call-1' },
      evidenceRefs: [],
      input: { command: 'systemctl status nginx' },
      output: null,
      error: null,
      target: null,
      idempotency: null,
      approval: null,
    },
    assistant,
  ];
  return { ...base, nodes };
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
    nodes: projectAgentConversationNodes(agentSessionEventFixture),
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
      expect(screen.getByText('Checking now.')).toBeVisible();
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

    expect(screen.getByText('What should the Agent complete?')).toBeVisible();
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
    expect(screen.getByRole('textbox')).toHaveValue('keep local draft');
    expect(container.querySelector('[data-slot="ai-composer-seat"]'))
      .toHaveAttribute('data-phase', 'active');
  });

  it('shows one Turn-level running indicator while reasoning and a tool are active', () => {
    const { container } = render(
      <AiWorkspaceRoot view={runningHierarchyView()} scope="workbench" />,
    );

    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-node-kind="reasoning"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tool-state="running"]')).toHaveLength(1);
    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent('In progress');
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('In progress'));
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

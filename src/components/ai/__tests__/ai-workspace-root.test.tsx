import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import {
  projectAgentConversationNodes,
  projectAskConversationNodes,
} from '@/lib/ai/conversation-projection';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  askStreamingConversationFixture,
  askStreamingMessageFixture,
} from '@/test/fixtures/ask-streaming';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';

function askView(status: AiSessionView['status'] = 'idle'): AiSessionView {
  const nodes = projectAskConversationNodes({
    conversation: askStreamingConversationFixture,
    messages: askStreamingMessageFixture,
    phase: status === 'running' ? 'streaming' : 'idle',
  });
  return {
    summary: {
      id: askStreamingConversationFixture.id,
      kind: 'ask',
      title: askStreamingConversationFixture.title,
      updatedAt: askStreamingConversationFixture.updatedAt,
      status,
      scopeKey: 'workbench',
      archived: false,
    },
    snapshot: {
      kind: 'ask',
      conversation: askStreamingConversationFixture,
      messages: askStreamingMessageFixture,
      phase: status === 'running' ? 'streaming' : 'idle',
    },
    nodes,
    activity: null,
    inbox: [],
    pendingApproval: null,
    status,
    error: null,
    throughSeq: null,
    canLoadOlder: false,
  };
}

function runningHierarchyView(): AiSessionView {
  const base = askView('running');
  const user = base.nodes[0];
  const assistant = base.nodes[1];
  if (!user || !assistant) throw new Error('Ask fixture must project two nodes');
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

function agentView(): AiSessionView {
  const activity = projectAgentActivity(agentSessionEventFixture);
  const throughSeq = agentSessionEventFixture[agentSessionEventFixture.length - 1]?.seq ?? 0;
  return {
    summary: {
      id: 'session-fixture',
      kind: 'agent',
      title: 'Check nginx and report evidence.',
      updatedAt: '2026-09-02T08:00:02.000Z',
      status: activity.status,
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
        status: activity.status,
        ended: false,
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
    activity,
    inbox: [],
    pendingApproval: null,
    status: activity.status,
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
  it.each([320, 400, 720])(
    'keeps the complete single-column workspace structure at %d px',
    (width) => {
      const { container } = render(
        <div style={{ width, height: 640 }}>
          <AiWorkspaceRoot
            view={askView()}
            scope="workbench"
            providerLabel="Local provider"
            modelLabel="Model fixture"
            contextLabel="Workbench context"
            onClose={vi.fn()}
            onHistory={vi.fn()}
            onNewSession={vi.fn()}
            onSubmit={vi.fn()}
          />
        </div>,
      );

      const root = container.querySelector<HTMLElement>('[data-slot="ai-workspace-root"]');
      expect(root).toHaveClass('min-w-0', 'overflow-x-hidden');
      expect(root).toHaveAttribute('data-phase', 'active');
      expect(screen.getByText('Why did the deployment fail?')).toBeVisible();
      expect(screen.getByText('Inspecting the deployment output.')).toBeVisible();
      expect(screen.getByRole('textbox')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Session actions' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Session and input settings' })).toBeVisible();
      expect(root?.querySelector('[data-slot="message-scroller"]'))
        .toContainElement(root?.querySelector('[data-message-scroller-viewport]') ?? null);
      expect(root?.querySelectorAll('[data-message-scroller-viewport]')).toHaveLength(1);
      expect(root?.querySelectorAll('[data-slot="ai-workspace-content"] > aside')).toHaveLength(0);
    },
  );

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
            setView(askView());
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
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
  });

  it('shows Agent Conversation and Activity from one throughSeq while Ask hides the tab row', async () => {
    const user = userEvent.setup();
    const view = agentView();
    const { container, rerender } = render(
      <AiWorkspaceRoot
        view={view}
        scope="terminal"
        activityContent={<div data-testid="activity-fixture">Activity fixture</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Conversation' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeVisible();
    expect(container.querySelector('[data-slot="tabs"]')).toHaveAttribute(
      'data-through-seq',
      String(view.throughSeq),
    );
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByTestId('activity-fixture')).toBeVisible();

    rerender(<AiWorkspaceRoot view={askView()} scope="workbench" />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('log', { name: 'AI conversation' })).toBeVisible();
  });

  it('gives every icon-only workspace action an accessible name and tooltip', () => {
    const { container } = render(
      <AiWorkspaceRoot
        view={askView()}
        scope="workbench"
        onClose={vi.fn()}
        onHistory={vi.fn()}
        onNewSession={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    for (const name of [
      'Session actions',
      'Close AI assistant',
      'Session and input settings',
      'Send',
      'Scroll to latest message',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[data-base-ui-tooltip-trigger]')).toHaveLength(5);
    expect(within(screen.getByRole('button', { name: 'Session actions' })).queryByText(/./))
      .toBeNull();
  });
});

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { AgentSessionCommittedClient } from '@/lib/ai/agent-session-client';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionEventFixture, sessionEvent } from '@/test/fixtures/agent-session';
import type { AgentSessionEvent } from '@/types/agent-session';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import {
  createAiWorkspaceNavigationState,
  type AiWorkspaceNavigationState,
} from '@/lib/ai/panel-route';
import type { AiPendingApproval, AiSessionSummary, AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/components/ai/ai-panel.css';

const tool: AiConversationNodeOf<'tool'> = {
  kind: 'tool',
  key: 'tool:call-phase5',
  sourceKind: 'agent',
  sessionId: 'agent-phase5',
  turnId: 'turn-1',
  stepId: 'step-1',
  firstSeq: 4,
  lastSeq: 7,
  timestamp: '2026-09-03T00:00:00.000Z',
  callId: 'call-phase5',
  name: 'terminal.exec',
  summary: 'Restart nginx',
  state: 'approval',
  effect: 'stateChange',
  durationMs: null,
  detailRef: { kind: 'agentTool', sessionId: 'agent-phase5', callId: 'call-phase5' },
  evidenceRefs: ['evidence-1'],
  input: { command: 'systemctl restart nginx' },
  output: null,
  error: null,
  target: { kind: 'remote', targetId: 'prod-1', sessionId: 'terminal-1', label: 'Production' },
  idempotency: 'conditional',
  approval: {
    approvalId: 'approval-phase5',
    requestId: 'request-1',
    status: 'requested',
    risk: 'stateChange',
    prompt: 'Restart nginx',
    reason: 'Service configuration changed',
    expiresAtUnixMs: 2_000,
  },
};

const artifact: AiConversationNodeOf<'artifact'> = {
  kind: 'artifact',
  key: 'artifact:report',
  sourceKind: 'agent',
  sessionId: 'agent-phase5',
  turnId: 'turn-1',
  stepId: 'step-1',
  firstSeq: 8,
  lastSeq: 8,
  timestamp: '2026-09-03T00:00:01.000Z',
  artifactId: 'report',
  artifactKind: 'text',
  title: 'Deployment report',
  sizeBytes: 12,
  mediaType: 'text/plain',
  sha256: 'abc123',
  sensitivity: 'internal',
};

const pendingApproval: AiPendingApproval = {
  sessionId: 'agent-phase5',
  turnId: 'turn-1',
  stepId: 'step-1',
  requestId: 'request-1',
  callId: tool.callId,
  approvalId: 'approval-phase5',
  risk: 'stateChange',
  prompt: 'Restart nginx',
  reason: 'Service configuration changed',
  expiresAtUnixMs: 2_000,
  toolName: tool.name,
  target: tool.target,
  arguments: tool.input,
  effect: tool.effect,
  evidenceRefs: tool.evidenceRefs,
};

function agentView(approval: AiPendingApproval | null = null): AiSessionView {
  return {
    summary: {
      id: 'agent-phase5',
      kind: 'agent',
      title: 'Deploy safely',
      updatedAt: '2026-09-03T00:00:01.000Z',
      status: approval ? 'waiting' : 'running',
      scopeKey: 'terminal-1',
      archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: { sessionId: 'agent-phase5', taskId: 'task-1', goal: 'Deploy safely', createdAtUnixMs: 1 },
        status: approval ? 'waiting' : 'running',
        ended: false,
        archived: false,
        eventCount: 9,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: {
          plan: {
            version: 1,
            steps: [
              { id: 'plan-1', title: 'Inspect service', status: 'completed' },
              { id: 'plan-2', title: 'Restart safely', status: 'inProgress' },
            ],
          },
          evidence: [],
        },
        recovery: { kind: approval ? 'waitingApproval' : 'idle', status: 'none', summary: 'ok', lastCommittedSeq: 8 },
      },
    },
    nodes: [tool, artifact],
    activityNodes: [],
    inbox: [],
    pendingApproval: approval,
    status: approval ? 'waiting' : 'running',
    error: null,
    throughSeq: 8,
    canLoadOlder: false,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => cleanup());

describe('AI workspace Phase 5 workflows', () => {
  it('folds the committed Runtime task plan above the Composer', async () => {
    const user = userEvent.setup();
    render(<AiWorkspaceRoot view={agentView()} scope="terminal" />);
    const toggle = screen.getByRole('button', { name: 'Toggle 2 tasks' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 completed · 1 in progress')).toBeVisible();
    expect(screen.queryByText('Inspect service')).toBeNull();
    await user.click(toggle);
    expect(screen.getByText('Inspect service')).toBeVisible();
    expect(screen.getByText('Restart safely')).toBeVisible();
  });

  it('replaces the Composer with approval, keeps the draft, and exposes recoverable decisions', async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    const reject = vi.fn();
    const openTool = vi.fn();
    const composer = createAiComposerState({
      phase: 'waitingApproval',
      runtimeStatus: 'waiting',
      waitingApproval: true,
      sessionId: 'agent-phase5',
      draft: 'preserved draft',
    });
    const { rerender } = render(
      <AiWorkspaceRoot
        view={agentView(pendingApproval)}
        scope="terminal"
        composerState={composer}
        onApprove={approve}
        onReject={reject}
        onOpenTool={openTool}
      />,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('group', { name: /Approval required/ })).toBeVisible();
    expect(screen.getByText('Production')).toBeVisible();
    expect(screen.getAllByText('stateChange')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Approve once' })).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'View full parameters' }));
    expect(openTool).toHaveBeenCalledWith(tool);
    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(approve).toHaveBeenCalledOnce();

    rerender(
      <AiWorkspaceRoot
        view={agentView()}
        scope="terminal"
        composerState={createAiComposerState({ ...composer, phase: 'running', runtimeStatus: 'running', waitingApproval: false })}
      />,
    );
    expect(screen.getByRole('textbox').textContent).toBe('preserved draft');
  });

  it('shows approval pending and failure without reporting an approved result', () => {
    const composer = createAiComposerState({
      phase: 'waitingApproval', runtimeStatus: 'waiting', waitingApproval: true,
      sessionId: 'agent-phase5', draft: 'keep me',
    });
    const { rerender } = render(
      <AiWorkspaceRoot
        view={agentView(pendingApproval)} scope="terminal" composerState={composer}
        approvalDecision="approve"
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    expect(screen.getByText('Submitting approval decision')).toBeInTheDocument();

    rerender(
      <AiWorkspaceRoot
        view={agentView(pendingApproval)} scope="terminal" composerState={composer}
        approvalError="Runtime refused the decision"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Runtime refused the decision');
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeEnabled();
    expect(screen.getByRole('group', { name: /Approval required/ })).toBeVisible();
  });

  it('uses single-stack tool details and returns focus to the originating row', async () => {
    const user = userEvent.setup();
    function Harness(): React.ReactNode {
      const [navigation, setNavigation] = useState<AiWorkspaceNavigationState>({
        ...createAiWorkspaceNavigationState('agent-phase5'),
        route: { kind: 'toolDetails' as const, sessionId: 'agent-phase5', nodeKey: tool.key },
        returnFocus: { sessionId: 'agent-phase5', nodeKey: tool.key },
      });
      return (
        <div style={{ width: 720, height: 600 }}>
          <AiWorkspaceRoot
            view={agentView()}
            scope="terminal"
            navigation={navigation}
            onBack={() => setNavigation((current) => ({
              ...current,
              route: { kind: 'conversation', sessionId: 'agent-phase5' },
            }))}
            onRouteReturnComplete={() => setNavigation((current) => ({ ...current, returnFocus: null }))}
          />
        </div>
      );
    }
    const { container } = render(<Harness />);
    expect(container).toHaveTextContent('systemctl restart nginx');
    expect(container).toHaveTextContent('conditional');
    expect(container.querySelectorAll('[data-slot="ai-tool-details"]')).toHaveLength(1);
    expect(container.querySelectorAll('aside')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Command: Restart nginx' })).toHaveFocus());
  });

  it('opens a failed nested command by its key when another step reused the call ID', async () => {
    const user = userEvent.setup();
    const error = 'native policy rejects unscoped command network egress';
    const command = 'which docker && docker --version';
    const events = [
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-inspect' }),
      sessionEvent(1, {
        type: 'tool/call', turnId: 'turn-inspect', stepId: 'step-1',
        data: { call: { callId: 'call-1', name: 'exec_command', arguments: { command: 'echo earlier' } } },
      }),
      sessionEvent(2, {
        type: 'tool/result', turnId: 'turn-inspect', stepId: 'step-1',
        data: { callId: 'call-1', name: 'exec_command', status: 'completed', summary: 'earlier output' },
      }),
      sessionEvent(3, {
        type: 'tool/call', turnId: 'turn-inspect', stepId: 'step-2',
        data: { call: {
          callId: 'call-1', name: 'exec_command', arguments: { command, cwd: '/tmp' },
          effect: 'externalSideEffect', target: tool.target!,
        } },
      }),
      sessionEvent(4, {
        type: 'tool/result', turnId: 'turn-inspect', stepId: 'step-2',
        data: { callId: 'call-1', name: 'exec_command', status: 'failed', summary: error },
      }),
    ];
    const view = {
      ...agentView(),
      summary: { ...agentView().summary, id: 'session-fixture' },
      nodes: projectAgentChatNodes(events),
    };
    function Harness(): React.ReactNode {
      const [navigation, setNavigation] = useState(createAiWorkspaceNavigationState(view.summary.id));
      return <AiWorkspaceRoot
        view={view}
        scope="terminal"
        navigation={navigation}
        onOpenTool={(node) => setNavigation((current) => ({
          ...current,
          route: { kind: 'toolDetails', sessionId: node.sessionId, nodeKey: node.key },
        }))}
      />;
    }
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: `Command: ${error}` }));
    await user.click(screen.getByRole('button', { name: 'Open details for exec_command' }));
    const details = container.querySelector('[data-slot="ai-tool-details"]');
    expect(details).toHaveTextContent(command);
    expect(details).toHaveTextContent('/tmp');
    expect(details).toHaveTextContent(error);
    expect(details).toHaveTextContent('externalSideEffect');
    expect(details).toHaveTextContent('Production');
    expect(details).not.toHaveTextContent('echo earlier');
    expect(details).not.toHaveTextContent('earlier output');
    expect(details).not.toHaveTextContent('This item is not available');
  });

  it('loads Artifact content only after entering its details route', async () => {
    const loadArtifact = vi.fn(async () => ({
      metadata: {
        artifactId: 'report', kind: 'text', title: 'Deployment report', mediaType: 'text/plain',
        sha256: 'abc123', sizeBytes: 12, sensitivity: 'internal' as const, createdAtUnixMs: 1,
      },
      bodyBase64: btoa('lazy report'),
      truncated: false,
    }));
    const initial = createAiWorkspaceNavigationState('agent-phase5');
    const { rerender } = render(
      <AiWorkspaceRoot view={agentView()} scope="terminal" navigation={initial} loadArtifact={loadArtifact} />,
    );
    expect(loadArtifact).not.toHaveBeenCalled();

    rerender(
      <AiWorkspaceRoot
        view={agentView()}
        scope="terminal"
        navigation={{ ...initial, route: { kind: 'artifactDetails', sessionId: 'agent-phase5', artifactId: 'report' } }}
        loadArtifact={loadArtifact}
      />,
    );
    expect(await screen.findByText('lazy report')).toBeVisible();
    expect(loadArtifact).toHaveBeenCalledWith('agent-phase5', 'report', 256 * 1024);
  });

  it.each([320, 400, 720])('keeps Session Browser single-column at %d px and confirms archive', async (width) => {
    const user = userEvent.setup();
    const archive = vi.fn();
    const sessions: readonly AiSessionSummary[] = [{
      id: 'agent-history', kind: 'agent', title: 'Historical task', updatedAt: '2026-09-03T00:00:00.000Z',
      status: 'idle', scopeKey: 'workbench', archived: false,
    }];
    const { container } = render(
      <div style={{ width, height: 600 }}>
        <AiWorkspaceRoot
          view={agentView()}
          scope="terminal"
          navigation={{ ...createAiWorkspaceNavigationState(), route: { kind: 'sessions' } }}
          sessions={sessions}
          onArchiveSession={archive}
        />
      </div>,
    );
    expect(container.querySelectorAll('aside')).toHaveLength(0);
    expect(screen.getByText('Historical task')).toBeVisible();
    const sessionRow = screen.getByRole('treeitem');
    const actionsButton = container.querySelector<HTMLButtonElement>('.ai-session-row-menu');
    expect(actionsButton).not.toBeNull();
    fireEvent.click(actionsButton!);
    fireEvent.mouseLeave(sessionRow);
    expect(actionsButton).toHaveAttribute('data-popup-open');
    expect(actionsButton).toBeVisible();
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Archive this session?');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith(sessions[0]);
  });

  it('renders committed Agent nodes directly in the conversation-only surface', async () => {
    const user = userEvent.setup();
    render(
      <AiWorkspaceRoot
        view={agentView()}
        scope="terminal"
        navigation={createAiWorkspaceNavigationState('agent-phase5')}
        onOpenTool={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('log', { name: 'AI conversation' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Command: Restart nginx' }));
    expect(screen.getByRole('button', { name: 'Open details for terminal.exec' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open artifact Deployment report' })).toBeVisible();
  });
});


it('updates the task strip from live committed plan events with an unchanged initial snapshot, including clearing', async () => {
  const user = userEvent.setup();
  const initialSnapshot = { ...agentView().snapshot.value, header: { ...agentView().snapshot.value.header, sessionId: 'session-fixture' }, task: { evidence: [], successCriteria: ['preserved'] } };
  const events = [...agentSessionEventFixture.slice(0, 3)];
  let publish: ((event: AgentSessionEvent) => void) | undefined;
  const client = new AgentSessionCommittedClient('session-fixture', {
    snapshot: async () => initialSnapshot,
    committedEvents: async ({ afterSeq }) => ({ events: events.filter((event) => afterSeq === undefined || event.seq > afterSeq) }),
    subscribe: async (listener) => { publish = listener; return () => undefined; },
  });
  const state = await client.connect();
  const { rerender } = render(<AiWorkspaceRoot view={agentSessionView(state)} scope="terminal" />);
  const unsubscribe = client.onChange((next) => rerender(<AiWorkspaceRoot view={agentSessionView(next)} scope="terminal" />));
  expect(screen.queryByRole('button', { name: /Toggle .* tasks/ })).toBeNull();
  const emitPlan = async (steps: Extract<AgentSessionEvent, { type: 'task/plan' }>['data']['steps']): Promise<void> => {
    const event = sessionEvent(events.length, { type: 'task/plan', data: { version: 1, steps } });
    events.push(event);
    await act(async () => { publish?.(event); await client.settled(); });
  };
  await emitPlan([{ id: 'live', title: 'Live task', status: 'inProgress' }]);
  expect(screen.getByText('1 in progress')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Toggle 1 tasks' }));
  expect(screen.getByText('Live task')).toBeVisible();
  await emitPlan([{ id: 'live', title: 'Updated live task', status: 'completed' }]);
  expect(screen.getByText('1 completed')).toBeVisible();
  expect(screen.getByText('Updated live task')).toBeVisible();
  expect(agentSessionView(client.state()).snapshot.value.task).toMatchObject({ successCriteria: ['preserved'] });
  expect(client.state().snapshot).toBe(initialSnapshot);
  await emitPlan([]);
  expect(screen.queryByRole('button', { name: /Toggle .* tasks/ })).toBeNull();
  unsubscribe();
  client.disconnect();
});

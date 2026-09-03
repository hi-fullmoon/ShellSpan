import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import {
  createAiWorkspaceNavigationState,
  type AiWorkspaceNavigationState,
} from '@/lib/ai/panel-route';
import type { AiPendingApproval, AiSessionSummary, AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

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
    expect(screen.getByText('1 completed')).toBeVisible();
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
    expect(screen.getByRole('textbox')).toHaveValue('preserved draft');
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
    await user.hover(screen.getByRole('treeitem'));
    await user.click(screen.getByRole('button', { name: 'More actions for Historical task' }));
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

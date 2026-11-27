import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiToolRow } from '@/components/ai/workspace/ai-tool-presentation';
import { OPEN_AGENT_SESSION_EVENT, OPEN_CONNECTION_DRAFT_EVENT } from '@/lib/app-actions/types';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

function createToolNode(overrides: Partial<AiConversationNodeOf<'tool'>>): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: 'tool-app-1',
    sourceKind: 'agent',
    sessionId: 'session-1',
    turnId: null,
    stepId: null,
    firstSeq: 1,
    lastSeq: 2,
    callId: 'call-app-1',
    name: 'app_navigate',
    nativeName: null,
    title: 'Navigate ShellSpan UI',
    state: 'succeeded',
    effect: 'none',
    detailRef: { kind: 'agentTool', sessionId: 'session-1', callId: 'call-app-1' },
    evidenceRefs: [],
    target: null,
    idempotency: 'conditional',
    approval: null,
    input: { target: 'workbenchTab', workbenchTab: 'logs' },
    output: {
      actionId: 'app-act-1',
      cardId: 'app-card-1',
      cardKind: 'navigation',
      title: 'Open workbench/logs',
      action: {
        type: 'navigateSection',
        section: 'workbench',
        workbenchTab: 'logs',
      },
    },
    summary: 'Dispatched UI navigation: Open workbench/logs',
    error: null,
    durationMs: 12,
    timestamp: '2026-11-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('App control tool presentation', () => {
  beforeAll(async () => {
    await initI18n('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({
      activeSection: 'terminal',
      activeWorkbenchTab: 'connections',
      settingsDialogOpen: false,
    });
  });

  it('renders a clickable Open button for app_navigate results and navigates on click', () => {
    render(<AiToolRow node={createToolNode({})} />);
    const openButton = screen.getByRole('button', { name: /^Open$/ });
    fireEvent.click(openButton);

    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('logs');
  });

  it('renders an Open draft form button for app_propose_action results', () => {
    const draftListener = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    document.addEventListener(OPEN_CONNECTION_DRAFT_EVENT, draftListener);
    try {
      render(
        <AiToolRow
          node={createToolNode({
            name: 'app_propose_action',
            title: 'Propose ShellSpan form draft',
            output: {
              proposalId: 'app-prop-1',
              actionId: 'app-act-2',
              cardId: 'app-card-2',
              kind: 'connectionProfile',
              summary: 'Add staging server',
              action: {
                type: 'openProposalDraft',
                proposalId: 'app-prop-1',
                kind: 'connectionProfile',
                draft: { name: 'Staging', host: '10.0.1.9', port: 22, username: 'deploy' },
              },
            },
          })}
        />,
      );
      const button = screen.getByRole('button', { name: /open draft form|打开草稿表单/i });
      fireEvent.click(button);
      expect(draftListener).toHaveBeenCalledTimes(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      document.removeEventListener(OPEN_CONNECTION_DRAFT_EVENT, draftListener);
    }
  });

  it('renders an Open session button for app_session results and dispatches openAgentSession', () => {
    const sessionListener = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    window.addEventListener(OPEN_AGENT_SESSION_EVENT, sessionListener);
    try {
      render(
        <AiToolRow
          node={createToolNode({
            name: 'app_session',
            title: 'Manage ShellSpan AI session',
            output: {
              sessionAction: 'create',
              sessionId: 'session-new-1',
              title: 'Inspect slow queries',
              started: true,
              promptQueued: true,
              focused: false,
              action: {
                type: 'openAgentSession',
                agentSessionId: 'session-new-1',
              },
            },
          })}
        />,
      );
      const button = screen.getByRole('button', { name: /^Open session$/ });
      expect(screen.getByText('Running')).toBeInTheDocument();
      fireEvent.click(button);
      expect(sessionListener).toHaveBeenCalledTimes(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.removeEventListener(OPEN_AGENT_SESSION_EVENT, sessionListener);
    }
  });
});

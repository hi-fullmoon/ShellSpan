import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_AGENT_SESSION_EVENT } from '@/lib/app-actions/types';
import { AgentNotificationMonitor } from '@/lib/notifications/agent-notification-monitor';
import { navigateToNotificationTarget } from '@/lib/notifications/navigation';
import {
  isAgentSessionCurrentlyVisible,
  isTerminalSessionCurrentlyVisible,
  sanitizeNotificationText,
  shouldDeliverDesktopNotification,
} from '@/lib/notifications/policy';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentSessionEvent } from '@/types/agent-session';

function baseEvent(overrides: { seq?: number; sessionId?: string; turnId?: string; stepId?: string } = {}) {
  return {
    version: 5 as const,
    seq: overrides.seq ?? 1,
    timeUnixMs: 1_760_000_000_000,
    sessionId: overrides.sessionId ?? 'agent-root',
    turnId: overrides.turnId ?? 'turn-1',
    ...(overrides.stepId ? { stepId: overrides.stepId } : {}),
  };
}

describe('desktop notification policy', () => {
  it('evaluates trigger policies and master/category toggles', () => {
    expect(shouldDeliverDesktopNotification({
      enabled: false,
      categoryEnabled: true,
      policy: 'always',
      windowFocused: false,
      targetVisible: false,
    })).toBe(false);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: false,
      policy: 'always',
      windowFocused: false,
      targetVisible: false,
    })).toBe(false);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: true,
      policy: 'whenUnfocusedOrHidden',
      windowFocused: true,
      targetVisible: true,
    })).toBe(false);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: true,
      policy: 'whenUnfocusedOrHidden',
      windowFocused: true,
      targetVisible: false,
    })).toBe(true);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: true,
      policy: 'whenWindowUnfocused',
      windowFocused: true,
      targetVisible: false,
    })).toBe(false);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: true,
      policy: 'whenWindowUnfocused',
      windowFocused: false,
      targetVisible: false,
    })).toBe(true);

    expect(shouldDeliverDesktopNotification({
      enabled: true,
      categoryEnabled: true,
      policy: 'always',
      windowFocused: true,
      targetVisible: true,
    })).toBe(true);
  });

  it('sanitizes C0/C1 control characters and avoids splitting surrogate pairs on truncation', () => {
    expect(sanitizeNotificationText('  hello\n\t\x07world  ')).toBe('hello world');
    expect(sanitizeNotificationText('line\u0085break\u009B[31m')).toBe('line break [31m');
    expect(sanitizeNotificationText('abcdefghij', 6)).toBe('abcde…');
    const truncatedEmoji = sanitizeNotificationText('ab😀cd', 4);
    expect(truncatedEmoji).toBe('ab…');
    expect(/[\uD800-\uDFFF]/.test(truncatedEmoji)).toBe(false);
  });

  it('checks terminal and agent session visibility across normal panel, focus mode, and settings dialog', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    useFocusStore.setState({ enabled: false, terminalOpen: true, conversationSessionId: null });
    useAppStore.setState({ activeSection: 'terminal', settingsDialogOpen: false });
    useTerminalStore.setState({ activeSessionId: 'term-1' });
    useAiPanelStore.setState({
      panelOpenBySection: { workbench: false, terminal: true },
      activeSessionByScope: { workbench: null, terminal: 'agent-1', focus: null },
    });

    expect(isTerminalSessionCurrentlyVisible('term-1')).toBe(true);
    expect(isAgentSessionCurrentlyVisible('agent-1')).toBe(true);
    expect(isAgentSessionCurrentlyVisible('agent-2')).toBe(false);

    useAppStore.setState({ settingsDialogOpen: true });
    expect(isTerminalSessionCurrentlyVisible('term-1')).toBe(false);
    expect(isAgentSessionCurrentlyVisible('agent-1')).toBe(false);
    useAppStore.setState({ settingsDialogOpen: false });

    useAiPanelStore.getState().setOpen(false, 'terminal');
    expect(isAgentSessionCurrentlyVisible('agent-1')).toBe(false);

    useFocusStore.setState({ enabled: true, conversationSessionId: 'focus-agent-9' });
    useAiPanelStore.setState({
      activeSessionByScope: { workbench: null, terminal: null, focus: 'focus-agent-9' },
    });
    expect(isAgentSessionCurrentlyVisible('focus-agent-9')).toBe(true);
    expect(isAgentSessionCurrentlyVisible('agent-1')).toBe(false);

    vi.restoreAllMocks();
  });
});

describe('AgentNotificationMonitor', () => {
  it('notifies for approval, question, sudo, completion, and failure with deduplication', () => {
    const monitor = new AgentNotificationMonitor();

    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 1 }),
      type: 'session/created',
      data: {
        taskId: 'task-1',
        goal: 'Deploy nginx config',
        executionSurface: 'direct',
        target: { kind: 'remote', targetId: 'terminal-term-1', sessionId: 'term-1', label: 'prod-1' },
      },
    })).toBeNull();

    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 2 }),
      type: 'session/renamed',
      data: { title: 'Nginx Rollout', previousRevision: 0, clientOperationId: 'op-1' },
    })).toBeNull();

    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 3 }),
      type: 'turn/start',
    })).toBeNull();

    const approval = monitor.observeSessionEvent({
      ...baseEvent({ seq: 4 }),
      type: 'tool/approval',
      data: {
        requestId: 'req-1',
        callId: 'call-1',
        approvalId: 'appr-1',
        status: 'requested',
        reason: 'Reload systemd service',
      },
    });
    expect(approval).toMatchObject({
      kind: 'approval',
      sessionId: 'agent-root',
      sessionTitle: 'Nginx Rollout',
      detail: 'Reload systemd service',
      urgency: 'critical',
      target: {
        type: 'agentSession',
        agentSessionId: 'agent-root',
        terminalSessionId: 'term-1',
      },
    });
    // Duplicate approval request is suppressed.
    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 5 }),
      type: 'tool/approval',
      data: {
        requestId: 'req-1',
        callId: 'call-1',
        approvalId: 'appr-1',
        status: 'requested',
      },
    })).toBeNull();

    const question = monitor.observeSessionEvent({
      ...baseEvent({ seq: 6 }),
      type: 'question/requested',
      data: {
        identity: {
          questionRequestId: 'q-1',
          sessionId: 'agent-root',
          turnId: 'turn-1',
          stepId: 'step-1',
          requestId: 'req-q1',
          callId: 'call-q1',
        },
        arguments: {
          questions: [{ id: 'q', header: 'Target host', question: 'Which environment?', multi_select: false, options: [] }],
        },
        provider: { routeId: 'r1', modelId: 'm1' },
      },
    });
    expect(question).toMatchObject({
      kind: 'question',
      sessionTitle: 'Nginx Rollout',
      detail: 'Target host',
      urgency: 'critical',
    });

    const sudo = monitor.observeSudoPrompt({
      state: 'requested',
      promptId: 'sudo-1',
      host: '10.0.0.5',
      port: 22,
      username: 'ops',
      command: 'systemctl reload nginx',
    });
    expect(sudo).toMatchObject({
      kind: 'sudo',
      account: 'ops@10.0.0.5:22',
      urgency: 'critical',
    });
    expect(monitor.observeSudoPrompt({
      state: 'requested',
      promptId: 'sudo-1',
      host: '10.0.0.5',
      port: 22,
      username: 'ops',
      command: 'systemctl reload nginx',
    })).toBeNull();
    expect(monitor.observeSudoPrompt({ state: 'closed', promptId: 'sudo-1' })).toBeNull();

    const completed = monitor.observeSessionEvent({
      ...baseEvent({ seq: 7 }),
      type: 'turn/end',
      data: { reason: 'completed' },
    });
    expect(completed).toMatchObject({
      kind: 'completed',
      sessionId: 'agent-root',
      sessionTitle: 'Nginx Rollout',
      urgency: 'normal',
    });
    // Subsequent session/ended for the same turn does not double-notify.
    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 8 }),
      type: 'session/ended',
      data: { status: 'completed' },
    })).toBeNull();

    // Next turn failure emits once.
    monitor.observeSessionEvent({
      ...baseEvent({ seq: 9, turnId: 'turn-2' }),
      type: 'turn/start',
    });
    const failed = monitor.observeSessionEvent({
      ...baseEvent({ seq: 10, turnId: 'turn-2' }),
      type: 'agent/status',
      data: { status: 'failed', reason: 'Connection dropped' },
    });
    expect(failed).toMatchObject({
      kind: 'failed',
      detail: 'Connection dropped',
      urgency: 'critical',
    });
    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 11, turnId: 'turn-2' }),
      type: 'session/ended',
      data: { status: 'failed', reason: 'Connection dropped' },
    })).toBeNull();
  });

  it('routes child subagent approvals to the root session and suppresses child completion notices', () => {
    const monitor = new AgentNotificationMonitor();
    monitor.observeSessionEvent({
      ...baseEvent({ seq: 1, sessionId: 'agent-parent' }),
      type: 'session/created',
      data: { taskId: 'task-p', goal: 'Parent task', executionSurface: 'direct' },
    });
    monitor.observeSessionEvent({
      ...baseEvent({ seq: 2, sessionId: 'agent-child' }),
      type: 'session/created',
      data: {
        taskId: 'task-c',
        goal: 'Child task',
        parentSessionId: 'agent-parent',
        executionSurface: 'direct',
      },
    });

    const childApproval = monitor.observeSessionEvent({
      ...baseEvent({ seq: 3, sessionId: 'agent-child' }),
      type: 'tool/approval',
      data: { requestId: 'child-req', callId: 'c1', status: 'requested' },
    });
    expect(childApproval).toMatchObject({
      kind: 'approval',
      sessionId: 'agent-parent',
      sessionTitle: 'Parent task',
      target: { type: 'agentSession', agentSessionId: 'agent-parent' },
    });

    expect(monitor.observeSessionEvent({
      ...baseEvent({ seq: 4, sessionId: 'agent-child' }),
      type: 'turn/end',
      data: { reason: 'completed' },
    })).toBeNull();
  });

  it('deduplicates agent/status and session/ended failures when no turnId is present', () => {
    const monitor = new AgentNotificationMonitor();
    const withoutTurn = (seq: number) => ({
      version: 5 as const,
      seq,
      timeUnixMs: 1_760_000_000_000,
      sessionId: 'agent-restored',
    });

    const first = monitor.observeSessionEvent({
      ...withoutTurn(10),
      type: 'agent/status',
      data: { status: 'failed', reason: 'Approval expired' },
    });
    expect(first).toMatchObject({
      kind: 'failed',
      sessionId: 'agent-restored',
      detail: 'Approval expired',
      urgency: 'critical',
    });

    expect(monitor.observeSessionEvent({
      ...withoutTurn(11),
      type: 'session/ended',
      data: { status: 'failed', reason: 'Approval expired' },
    })).toBeNull();

    // Starting a new turn resets terminal notification suppression.
    monitor.observeSessionEvent({
      ...baseEvent({ seq: 12, sessionId: 'agent-restored', turnId: 'turn-retry' }),
      type: 'turn/start',
    });
    expect(monitor.observeSessionEvent({
      ...withoutTurn(13),
      type: 'agent/status',
      data: { status: 'failed', reason: 'Retry failed' },
    })).toMatchObject({
      kind: 'failed',
      detail: 'Retry failed',
    });
  });
});

describe('navigateToNotificationTarget', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeSection: 'workbench',
      settingsDialogOpen: true,
      activeSettingsSection: 'general',
    });
    useFocusStore.setState({
      enabled: false,
      hasOpened: false,
      terminalOpen: true,
      targetSessionId: null,
      conversationSessionId: null,
      busy: false,
    });
    useAiPanelStore.setState({
      panelOpenBySection: { workbench: false, terminal: false },
      activeSessionByScope: { workbench: null, terminal: null, focus: null },
      pendingOpenSessionId: null,
    });
    useTerminalStore.setState({
      sessions: [
        {
          sessionId: 'term-1',
          host: '10.0.0.1',
          port: 22,
          username: 'root',
          title: 'prod-1',
          status: 'connected',
        },
      ],
      activeSessionId: null,
    });
  });

  it('opens terminal AI panel, activates bound terminal, closes settings, and requests the session', async () => {
    const received: string[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    };
    window.addEventListener(OPEN_AGENT_SESSION_EVENT, listener);

    navigateToNotificationTarget({
      type: 'agentSession',
      agentSessionId: 'agent-42',
      terminalSessionId: 'term-1',
    });

    expect(useAppStore.getState().settingsDialogOpen).toBe(false);
    expect(useAppStore.getState().activeSection).toBe('terminal');
    expect(useTerminalStore.getState().activeSessionId).toBe('term-1');
    expect(useAiPanelStore.getState().panelOpenBySection.terminal).toBe(true);
    expect(useAiPanelStore.getState().pendingOpenSessionId).toBe('agent-42');

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(received).toEqual(['agent-42']);
    window.removeEventListener(OPEN_AGENT_SESSION_EVENT, listener);
  });

  it('opens workbench AI panel for workbench ask sessions', () => {
    useAppStore.setState({ activeSection: 'sftp' });
    navigateToNotificationTarget({
      type: 'agentSession',
      agentSessionId: 'ask-workbench-7',
    });

    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAiPanelStore.getState().panelOpenBySection.workbench).toBe(true);
    expect(useAiPanelStore.getState().pendingOpenSessionId).toBe('ask-workbench-7');
  });

  it('enters focus mode for focus-agent sessions and focuses terminal or settings targets', () => {
    navigateToNotificationTarget({
      type: 'agentSession',
      agentSessionId: 'focus-agent-99',
    });
    expect(useFocusStore.getState().enabled).toBe(true);
    expect(useFocusStore.getState().conversationSessionId).toBe('focus-agent-99');

    navigateToNotificationTarget({
      type: 'settings',
      settingsSection: 'notifications',
    });
    expect(useAppStore.getState().settingsDialogOpen).toBe(true);
    expect(useAppStore.getState().activeSettingsSection).toBe('notifications');

    navigateToNotificationTarget({
      type: 'terminalSession',
      terminalSessionId: 'term-1',
    });
    expect(useAppStore.getState().settingsDialogOpen).toBe(false);
    expect(useAppStore.getState().activeSection).toBe('terminal');
    expect(useTerminalStore.getState().activeSessionId).toBe('term-1');

    useAppStore.setState({ settingsDialogOpen: true });
    navigateToNotificationTarget({
      type: 'section',
      section: 'sftp',
    });
    expect(useAppStore.getState().settingsDialogOpen).toBe(false);
    expect(useAppStore.getState().activeSection).toBe('sftp');
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { AppActionDedupeSet } from '../dedupe';
import { dispatchAppAction } from '../registry';
import {
  OPEN_AGENT_SESSION_EVENT,
  OPEN_CONNECTION_DRAFT_EVENT,
  OPEN_PORT_FORWARD_DRAFT_EVENT,
  PREFILL_AGENT_PROMPT_EVENT,
} from '../types';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';

const SAMPLE_PROFILE: ConnectionProfile = {
  id: 'profile-prod-1',
  name: 'Prod API',
  host: '10.0.0.10',
  port: 22,
  username: 'deploy',
  authMethod: 'key',
  createdAt: 1,
  updatedAt: 1,
};

describe('app-actions registry', () => {
  beforeAll(async () => {
    await initI18n('en-US');
  });

  beforeEach(() => {
    useAppStore.setState({
      activeSection: 'terminal',
      activeWorkbenchTab: 'connections',
      settingsDialogOpen: false,
    });
    useFocusStore.setState({
      enabled: false,
      terminalOpen: true,
      targetSessionId: null,
      conversationSessionId: null,
    });
    useProfileStore.setState({
      profiles: [SAMPLE_PROFILE],
      initialized: true,
    });
    useTerminalStore.setState({
      sessions: [],
      activeSessionId: null,
    });
    useToastStore.setState({ toasts: [] });
  });

  it('deduplicates repeated agent actions by actionId', () => {
    const dedupe = new AppActionDedupeSet(8);
    const first = dispatchAppAction(
      { type: 'navigateSection', section: 'workbench', workbenchTab: 'logs' },
      { source: 'agent', actionId: 'act-1' },
      dedupe,
    );
    const second = dispatchAppAction(
      { type: 'navigateSection', section: 'workbench', workbenchTab: 'monitor' },
      { source: 'agent', actionId: 'act-1' },
      dedupe,
    );

    expect(first).toEqual({ status: 'applied', exitedFocusMode: false });
    expect(second).toEqual({ status: 'deduplicated' });
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('logs');
  });

  it('exits Focus Mode automatically and notifies when agent navigates outside Focus Mode', () => {
    useFocusStore.setState({ enabled: true, terminalOpen: true });
    const dedupe = new AppActionDedupeSet();

    const result = dispatchAppAction(
      { type: 'navigateSection', section: 'workbench', workbenchTab: 'logs' },
      { source: 'agent', actionId: 'act-focus-exit' },
      dedupe,
    );

    expect(result).toEqual({ status: 'applied', exitedFocusMode: true });
    expect(useFocusStore.getState().enabled).toBe(false);
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('logs');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('dispatches connection profile and port-forward draft events without exposing credentials', async () => {
    const dedupe = new AppActionDedupeSet();
    const connectionListener = vi.fn();
    const forwardListener = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    document.addEventListener(OPEN_CONNECTION_DRAFT_EVENT, connectionListener);
    document.addEventListener(OPEN_PORT_FORWARD_DRAFT_EVENT, forwardListener);
    try {
      const connResult = dispatchAppAction(
        {
          type: 'openProposalDraft',
          proposalId: 'prop-1',
          kind: 'connectionProfile',
          draft: { name: 'Staging', host: '10.0.1.20', port: 2222, username: 'ops' },
        },
        { source: 'agent', actionId: 'act-conn' },
        dedupe,
      );
      expect(connResult.status).toBe('applied');
      expect(connectionListener).toHaveBeenCalledTimes(1);

      const pfResult = dispatchAppAction(
        {
          type: 'openProposalDraft',
          proposalId: 'prop-2',
          kind: 'portForward',
          draft: {
            profileId: SAMPLE_PROFILE.id,
            name: 'Web UI',
            kind: 'local',
            localPort: 8080,
            remoteHost: '127.0.0.1',
            remotePort: 80,
          },
        },
        { source: 'agent', actionId: 'act-pf' },
        dedupe,
      );
      expect(pfResult.status).toBe('applied');
      expect(forwardListener).toHaveBeenCalledTimes(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      document.removeEventListener(OPEN_CONNECTION_DRAFT_EVENT, connectionListener);
      document.removeEventListener(OPEN_PORT_FORWARD_DRAFT_EVENT, forwardListener);
    }
  });

  it('returns targetNotFound for missing profiles and dispatches openAgentSession events', () => {
    const dedupe = new AppActionDedupeSet();
    const missing = dispatchAppAction(
      { type: 'openSftpPath', profileId: 'missing-id', path: '/var/log' },
      { source: 'user' },
      dedupe,
    );
    expect(missing.status).toBe('targetNotFound');

    useAiPanelStore.setState({ panelOpenBySection: { workbench: false, terminal: false } });
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    const sessionListener = vi.fn();
    window.addEventListener(OPEN_AGENT_SESSION_EVENT, sessionListener);
    try {
      const opened = dispatchAppAction(
        { type: 'openAgentSession', agentSessionId: 'session-99' },
        { source: 'user' },
        dedupe,
      );
      expect(opened.status).toBe('applied');
      expect(useAiPanelStore.getState().panelOpenBySection.terminal).toBe(true);
      expect(sessionListener).toHaveBeenCalledTimes(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.removeEventListener(OPEN_AGENT_SESSION_EVENT, sessionListener);
    }
  });

  it('dispatches connectTerminalProfile and openLocalTerminal actions through standard terminal hooks', () => {
    const dedupe = new AppActionDedupeSet();
    const connectListener = vi.fn();
    const newTabListener = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    document.addEventListener('shellspan:connect-profile', connectListener);
    document.addEventListener('shellspan:new-terminal-tab', newTabListener);
    try {
      const missingConnect = dispatchAppAction(
        { type: 'connectTerminalProfile', profileId: 'unknown-profile' },
        { source: 'agent', actionId: 'act-term-missing' },
        dedupe,
      );
      expect(missingConnect.status).toBe('targetNotFound');

      const connected = dispatchAppAction(
        { type: 'connectTerminalProfile', profileId: SAMPLE_PROFILE.id, initialDirectory: '/var/log' },
        { source: 'agent', actionId: 'act-term-1' },
        dedupe,
      );
      expect(connected.status).toBe('applied');
      expect(connectListener).toHaveBeenCalledTimes(1);

      const local = dispatchAppAction(
        { type: 'openLocalTerminal' },
        { source: 'agent', actionId: 'act-term-local' },
        dedupe,
      );
      expect(local.status).toBe('applied');
      expect(useAppStore.getState().activeSection).toBe('terminal');
      expect(newTabListener).toHaveBeenCalledTimes(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      document.removeEventListener('shellspan:connect-profile', connectListener);
      document.removeEventListener('shellspan:new-terminal-tab', newTabListener);
    }
  });

  it('prefills deep-link agent prompts into draft without auto-submitting and shows notice', () => {
    const dedupe = new AppActionDedupeSet();
    useAiPanelStore.setState({ panelOpenBySection: { workbench: false, terminal: false } });
    const prefillListener = vi.fn();
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    window.addEventListener(PREFILL_AGENT_PROMPT_EVENT, prefillListener);
    try {
      const result = dispatchAppAction(
        { type: 'prefillAgentPrompt', prompt: 'Inspect nginx errors', profileId: SAMPLE_PROFILE.id },
        { source: 'deepLink', actionId: 'deeplink-1' },
        dedupe,
      );
      expect(result.status).toBe('applied');
      expect(useAiPanelStore.getState().panelOpenBySection.terminal).toBe(true);
      expect(prefillListener).toHaveBeenCalledTimes(1);
      expect(useToastStore.getState().toasts).toHaveLength(1);
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.removeEventListener(PREFILL_AGENT_PROMPT_EVENT, prefillListener);
    }
  });
});

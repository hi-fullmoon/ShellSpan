import { beforeEach, describe, expect, it } from 'vitest';
import { handleDeepLinkDispatch, handleLiveAgentAppActionEvent } from '../useAppActionBridge';
import { liveAppActionDedupe } from '@/lib/app-actions/dedupe';
import { useAppStore } from '@/stores/appStore';
import type { DeepLinkDispatch } from '@/types/agent-app-action';
import type { AgentSessionEvent } from '@/types/agent-session';

describe('useAppActionBridge live event handler', () => {
  beforeEach(() => {
    liveAppActionDedupe.clear();
    useAppStore.setState({
      activeSection: 'terminal',
      activeWorkbenchTab: 'connections',
      settingsDialogOpen: false,
    });
  });

  it('executes live app_action/dispatched events once and ignores duplicate actionIds', () => {
    const event: AgentSessionEvent = {
      version: 5,
      sessionId: 'session-1',
      seq: 12,
      timeUnixMs: 1_700_000_000_000,
      type: 'app_action/dispatched',
      data: {
        actionId: 'live-act-1',
        callId: 'call-1',
        requiresFocus: true,
        action: {
          type: 'navigateSection',
          section: 'workbench',
          workbenchTab: 'monitor',
        },
      },
    };

    handleLiveAgentAppActionEvent(event);
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('monitor');

    useAppStore.setState({ activeSection: 'terminal' });
    handleLiveAgentAppActionEvent(event);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('ignores non-dispatched events such as durable app_action/card records', () => {
    const cardEvent: AgentSessionEvent = {
      version: 5,
      sessionId: 'session-1',
      seq: 13,
      timeUnixMs: 1_700_000_000_001,
      type: 'app_action/card',
      data: {
        cardId: 'card-1',
        callId: 'call-1',
        kind: 'navigation',
        title: 'Open logs',
        action: {
          type: 'navigateSection',
          section: 'workbench',
          workbenchTab: 'logs',
        },
      },
    };

    handleLiveAgentAppActionEvent(cardEvent);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('deduplicates deep-link dispatches received via both live event and startup drain', () => {
    const dispatch: DeepLinkDispatch = {
      actionId: 'deeplink-42',
      action: {
        type: 'navigateSection',
        section: 'workbench',
        workbenchTab: 'logs',
      },
    };
    handleDeepLinkDispatch(dispatch);
    expect(useAppStore.getState().activeSection).toBe('workbench');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('logs');

    useAppStore.setState({ activeSection: 'terminal' });
    handleDeepLinkDispatch(dispatch);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });
});

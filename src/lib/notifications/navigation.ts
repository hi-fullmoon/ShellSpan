import { dispatchAppAction } from '@/lib/app-actions/registry';
import { OPEN_AGENT_SESSION_EVENT } from '@/lib/app-actions/types';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { DesktopNotificationTarget } from '@/types';

function resolveAgentSessionWorkspace(agentSessionId: string): 'focus' | 'workbench' | 'terminal' {
  if (agentSessionId.startsWith('focus-agent-')) {
    return 'focus';
  }
  if (agentSessionId.startsWith('ask-workbench-')) {
    return 'workbench';
  }
  return 'terminal';
}

export function navigateToNotificationTarget(target: DesktopNotificationTarget): void {
  switch (target.type) {
    case 'none':
      return;

    case 'settings': {
      dispatchAppAction(
        { type: 'navigateSettings', settingsSection: target.settingsSection },
        { source: 'user', requiresFocus: true },
      );
      return;
    }

    case 'section': {
      const app = useAppStore.getState();
      if (app.settingsDialogOpen) {
        app.setSettingsDialogOpen(false);
      }
      dispatchAppAction(
        { type: 'navigateSection', section: target.section },
        { source: 'user', requiresFocus: true },
      );
      return;
    }

    case 'terminalSession': {
      dispatchAppAction(
        { type: 'focusTerminal', terminalSessionId: target.terminalSessionId },
        { source: 'user', requiresFocus: true },
      );
      return;
    }

    case 'agentSession': {
      const workspace = resolveAgentSessionWorkspace(target.agentSessionId);
      const app = useAppStore.getState();
      const focus = useFocusStore.getState();
      const aiPanel = useAiPanelStore.getState();
      const terminal = useTerminalStore.getState();

      if (app.settingsDialogOpen) {
        app.setSettingsDialogOpen(false);
      }

      if (workspace === 'focus') {
        if (!focus.enabled) {
          focus.enter();
        }
        useFocusStore.getState().setConversation(target.agentSessionId);
        if (target.terminalSessionId) {
          const currentFocus = useFocusStore.getState();
          if (currentFocus.targetSessionId !== target.terminalSessionId) {
            currentFocus.setTarget(target.terminalSessionId);
          }
        }
        app.setActiveSection('terminal');
      } else if (workspace === 'workbench') {
        if (focus.enabled) {
          focus.leave();
        }
        app.setActiveSection('workbench');
        aiPanel.setOpen(true, 'workbench');
      } else {
        if (focus.enabled) {
          focus.leave();
        }
        if (
          target.terminalSessionId
          && terminal.sessions.some((session) => session.sessionId === target.terminalSessionId)
        ) {
          terminal.setActiveSession(target.terminalSessionId);
        }
        app.setActiveSection('terminal');
        aiPanel.setOpen(true, 'terminal');
      }

      // Store pending request for lazily-mounted AI panels and also broadcast
      // immediately for already-mounted session controllers.
      aiPanel.requestOpenSession(target.agentSessionId);
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(OPEN_AGENT_SESSION_EVENT, {
          detail: { sessionId: target.agentSessionId },
        }));
      });
      return;
    }
  }
}

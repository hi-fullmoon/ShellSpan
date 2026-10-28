import { create } from 'zustand';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import type { AgentTerminalLeaseView } from './agent-terminal-lease-state';

export interface TerminalTaskRequest {
  agentSessionId: string;
  terminalSessionId: string;
  workspace: 'terminal' | 'focus';
}

export const useTerminalTaskNavigation = create<{
  request: TerminalTaskRequest | null;
  setRequest: (request: TerminalTaskRequest | null) => void;
  displayedSessionByWorkspace: Record<TerminalTaskRequest['workspace'], string | null>;
  setDisplayedSession: (workspace: TerminalTaskRequest['workspace'], sessionId: string | null) => void;
}>(set => ({
  request: null,
  setRequest: request => set({ request }),
  displayedSessionByWorkspace: { terminal: null, focus: null },
  setDisplayedSession: (workspace, sessionId) => set(state => (
    state.displayedSessionByWorkspace[workspace] === sessionId ? state : {
      displayedSessionByWorkspace: { ...state.displayedSessionByWorkspace, [workspace]: sessionId },
    }
  )),
}));

export function terminalTaskWorkspace(lease: AgentTerminalLeaseView): 'terminal' | 'focus' {
  return lease.workspace ?? (lease.agentSessionId.startsWith('focus-agent-') ? 'focus' : 'terminal');
}

export function openTerminalTask(lease: AgentTerminalLeaseView): boolean {
  const workspace = terminalTaskWorkspace(lease);
  if (workspace === 'focus') {
    const focus = useFocusStore.getState();
    if (focus.busy && focus.targetSessionId !== lease.sessionId) return false;
    if (!focus.enabled) focus.enter();
    if (useFocusStore.getState().targetSessionId !== lease.sessionId
      && !useFocusStore.getState().setTarget(lease.sessionId)) return false;
  } else {
    useFocusStore.getState().leave();
  }
  useTerminalStore.getState().setActiveSession(lease.sessionId);
  useAppStore.getState().setActiveSection('terminal');
  useAiPanelStore.getState().setOpen(true, 'terminal');
  useTerminalTaskNavigation.getState().setRequest({
    workspace, agentSessionId: lease.agentSessionId, terminalSessionId: lease.sessionId,
  });
  return true;
}

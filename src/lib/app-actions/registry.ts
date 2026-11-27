import { openHostPath } from '@/lib/host/host-quick-actions';
import { t } from '@/locales';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useProfileStore } from '@/stores/profileStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useToastStore } from '@/stores/toastStore';
import type { PortForwardKind } from '@/types';
import { liveAppActionDedupe, type AppActionDedupeSet } from './dedupe';
import {
  OPEN_AGENT_SESSION_EVENT,
  OPEN_CONNECTION_DRAFT_EVENT,
  OPEN_PORT_FORWARD_DRAFT_EVENT,
  PREFILL_AGENT_PROMPT_EVENT,
  type AppActionDispatchContext,
  type AppActionDispatchResult,
  type AppUiAction,
  type ConnectionProfileDraft,
  type PortForwardRuleDraft,
} from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

function parseConnectionDraft(raw: Record<string, unknown>): ConnectionProfileDraft | null {
  const host = asString(raw.host);
  if (!host) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  return {
    name: asString(raw.name),
    host,
    port: asPort(raw.port),
    username: asString(raw.username),
    group: asString(raw.group),
    tags,
    notes: asString(raw.notes),
  };
}

function parsePortForwardDraft(raw: Record<string, unknown>): PortForwardRuleDraft | null {
  const profileId = asString(raw.profileId);
  const name = asString(raw.name);
  const kind = raw.kind;
  const localPort = asPort(raw.localPort);
  if (
    !profileId
    || !name
    || (kind !== 'local' && kind !== 'remote' && kind !== 'dynamic')
    || !localPort
  ) {
    return null;
  }
  const remotePort = asPort(raw.remotePort);
  if (kind !== 'dynamic' && !remotePort) {
    return null;
  }
  return {
    profileId,
    name,
    kind: kind as PortForwardKind,
    localPort,
    remoteHost: asString(raw.remoteHost),
    remotePort,
    autoStart: Boolean(raw.autoStart),
  };
}

function maybeExitFocusModeFor(action: AppUiAction, source: AppActionDispatchContext['source']): boolean {
  const focus = useFocusStore.getState();
  if (!focus.enabled) return false;
  if (
    action.type === 'focusTerminal'
    || action.type === 'connectTerminalProfile'
    || action.type === 'openLocalTerminal'
    || action.type === 'openAgentSession'
    || action.type === 'prefillAgentPrompt'
  ) {
    return false;
  }
  if (action.type === 'navigateSection' && action.section === 'terminal') {
    if (!focus.terminalOpen) focus.setTerminalOpen(true);
    return false;
  }
  focus.leave();
  if (source === 'agent') {
    useToastStore.getState().addToast(t('appAction.exitedFocusMode'), 'info');
  }
  return true;
}

export function dispatchAppAction(
  action: AppUiAction,
  context: AppActionDispatchContext,
  dedupe: AppActionDedupeSet = liveAppActionDedupe,
): AppActionDispatchResult {
  if (context.actionId && !dedupe.claim(context.actionId)) {
    return { status: 'deduplicated' };
  }

  const exitedFocusMode = maybeExitFocusModeFor(action, context.source);

  switch (action.type) {
    case 'navigateSection': {
      const app = useAppStore.getState();
      app.setActiveSection(action.section);
      if (action.workbenchTab) {
        app.setActiveWorkbenchTab(action.workbenchTab);
      }
      return { status: 'applied', exitedFocusMode };
    }
    case 'navigateSettings': {
      useAppStore.getState().openSettings(action.settingsSection);
      return { status: 'applied', exitedFocusMode };
    }
    case 'focusTerminal': {
      const terminal = useTerminalStore.getState();
      const target = terminal.sessions.find((session) => session.sessionId === action.terminalSessionId);
      if (!target) {
        return {
          status: 'targetNotFound',
          exitedFocusMode,
          detail: `Terminal session ${action.terminalSessionId} not found`,
        };
      }
      terminal.setActiveSession(action.terminalSessionId);
      const focus = useFocusStore.getState();
      if (focus.enabled && !focus.terminalOpen) {
        focus.setTerminalOpen(true);
      }
      useAppStore.getState().setActiveSection('terminal');
      return { status: 'applied', exitedFocusMode };
    }
    case 'connectTerminalProfile': {
      const profile = useProfileStore.getState().getProfile(action.profileId);
      if (!profile) {
        return {
          status: 'targetNotFound',
          exitedFocusMode,
          detail: `Profile ${action.profileId} not found`,
        };
      }
      const focus = useFocusStore.getState();
      if (focus.enabled && !focus.terminalOpen) {
        focus.setTerminalOpen(true);
      }
      document.dispatchEvent(new CustomEvent('shellspan:connect-profile', {
        detail: {
          profileId: action.profileId,
          target: 'terminal',
          initialDirectory: action.initialDirectory,
        },
      }));
      return { status: 'applied', exitedFocusMode };
    }
    case 'openLocalTerminal': {
      const focus = useFocusStore.getState();
      if (focus.enabled && !focus.terminalOpen) {
        focus.setTerminalOpen(true);
      }
      useAppStore.getState().setActiveSection('terminal');
      requestAnimationFrame(() => {
        document.dispatchEvent(new Event('shellspan:new-terminal-tab'));
      });
      return { status: 'applied', exitedFocusMode };
    }
    case 'openSftpPath': {
      const profile = useProfileStore.getState().getProfile(action.profileId);
      if (!profile) {
        return {
          status: 'targetNotFound',
          exitedFocusMode,
          detail: `Profile ${action.profileId} not found`,
        };
      }
      openHostPath(profile, action.path, 'sftp', action.side ?? 'remote');
      useAppStore.getState().setActiveSection('sftp');
      return { status: 'applied', exitedFocusMode };
    }
    case 'openHostTool': {
      const profile = useProfileStore.getState().getProfile(action.profileId);
      if (!profile) {
        return {
          status: 'targetNotFound',
          exitedFocusMode,
          detail: `Profile ${action.profileId} not found`,
        };
      }
      const app = useAppStore.getState();
      app.setActiveSection('workbench');
      app.setActiveWorkbenchTab('connections');
      document.dispatchEvent(new CustomEvent('shellspan:open-host-tool', {
        detail: { profileId: action.profileId, tool: action.tool },
      }));
      return { status: 'applied', exitedFocusMode };
    }
    case 'openAgentSession': {
      const focus = useFocusStore.getState();
      if (!focus.enabled) {
        const activeSection = useAppStore.getState().activeSection;
        const aiSection = activeSection === 'terminal' ? 'terminal' : 'workbench';
        if (activeSection === 'sftp') {
          useAppStore.getState().setActiveSection('workbench');
        }
        useAiPanelStore.getState().setOpen(true, aiSection);
      }
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(OPEN_AGENT_SESSION_EVENT, {
          detail: { sessionId: action.agentSessionId },
        }));
      });
      return { status: 'applied', exitedFocusMode };
    }
    case 'prefillAgentPrompt': {
      const prompt = action.prompt.trim();
      if (!prompt) {
        return { status: 'invalidPayload', exitedFocusMode, detail: 'Prompt must be non-empty' };
      }
      const focus = useFocusStore.getState();
      if (!focus.enabled) {
        const activeSection = useAppStore.getState().activeSection;
        const aiSection = activeSection === 'terminal' ? 'terminal' : 'workbench';
        if (activeSection === 'sftp') {
          useAppStore.getState().setActiveSection('workbench');
        }
        useAiPanelStore.getState().setOpen(true, aiSection);
      }
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(PREFILL_AGENT_PROMPT_EVENT, {
          detail: { prompt, profileId: action.profileId },
        }));
      });
      if (context.source === 'deepLink') {
        useToastStore.getState().addToast(t('appAction.deepLinkPromptPrefilled'), 'info');
      }
      return { status: 'applied', exitedFocusMode };
    }
    case 'openProposalDraft': {
      const raw = asRecord(action.draft);
      if (!raw) {
        return { status: 'invalidPayload', exitedFocusMode, detail: 'Draft payload must be an object' };
      }
      if (action.kind === 'connectionProfile') {
        const draft = parseConnectionDraft(raw);
        if (!draft) {
          return { status: 'invalidPayload', exitedFocusMode, detail: 'Invalid connectionProfile draft' };
        }
        const app = useAppStore.getState();
        app.setActiveSection('workbench');
        app.setActiveWorkbenchTab('connections');
        requestAnimationFrame(() => {
          document.dispatchEvent(new CustomEvent(OPEN_CONNECTION_DRAFT_EVENT, {
            detail: { proposalId: action.proposalId, draft },
          }));
        });
        return { status: 'applied', exitedFocusMode };
      }
      if (action.kind === 'portForward') {
        const draft = parsePortForwardDraft(raw);
        if (!draft) {
          return { status: 'invalidPayload', exitedFocusMode, detail: 'Invalid portForward draft' };
        }
        const profile = useProfileStore.getState().getProfile(draft.profileId);
        if (!profile) {
          return {
            status: 'targetNotFound',
            exitedFocusMode,
            detail: `Profile ${draft.profileId} not found`,
          };
        }
        const app = useAppStore.getState();
        app.setActiveSection('workbench');
        app.setActiveWorkbenchTab('connections');
        requestAnimationFrame(() => {
          document.dispatchEvent(new CustomEvent(OPEN_PORT_FORWARD_DRAFT_EVENT, {
            detail: { proposalId: action.proposalId, draft },
          }));
        });
        return { status: 'applied', exitedFocusMode };
      }
      return { status: 'invalidPayload', exitedFocusMode, detail: 'Unsupported proposal draft kind' };
    }
  }
}

export function switchSftpConnection(connectionId: string): void {
  useSftpStore.getState().setActiveConnection(connectionId);
  useAppStore.getState().setActiveSection('sftp');
}

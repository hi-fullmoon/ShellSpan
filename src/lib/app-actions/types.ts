import type {
  AppHostToolKind,
  AppProposalKind,
  AppUiAction,
  ConnectionProfileDraft,
  PortForwardRuleDraft,
} from '@/types/agent-app-action';

export type AppActionSource = 'user' | 'shortcut' | 'palette' | 'agent' | 'deepLink';

export interface AppActionDispatchContext {
  readonly source: AppActionSource;
  readonly actionId?: string;
  readonly requiresFocus?: boolean;
}

export type AppActionDispatchStatus =
  | 'applied'
  | 'deduplicated'
  | 'targetNotFound'
  | 'invalidPayload';

export interface AppActionDispatchResult {
  readonly status: AppActionDispatchStatus;
  readonly exitedFocusMode?: boolean;
  readonly detail?: string;
}

export const OPEN_CONNECTION_DRAFT_EVENT = 'shellspan:open-connection-draft';
export const OPEN_PORT_FORWARD_DRAFT_EVENT = 'shellspan:open-port-forward-draft';
export const OPEN_AGENT_SESSION_EVENT = 'shellspan:open-agent-session';
export const PREFILL_AGENT_PROMPT_EVENT = 'shellspan:prefill-agent-prompt';

export interface ConnectionDraftEventDetail {
  readonly proposalId?: string;
  readonly draft: ConnectionProfileDraft;
}

export interface PortForwardDraftEventDetail {
  readonly proposalId?: string;
  readonly draft: PortForwardRuleDraft;
}

export interface OpenAgentSessionEventDetail {
  readonly sessionId: string;
}

export interface PrefillAgentPromptEventDetail {
  readonly prompt: string;
  readonly profileId?: string;
}

export type {
  AppHostToolKind,
  AppProposalKind,
  AppUiAction,
  ConnectionProfileDraft,
  PortForwardRuleDraft,
};

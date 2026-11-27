import type { AppSection, PortForwardKind, SettingsSection, WorkbenchTab } from '@/types';

export type AppActionCardKind =
  | 'navigation'
  | 'terminal'
  | 'sftpPath'
  | 'hostTool'
  | 'agentSession'
  | 'proposalDraft';

export type AppProposalKind = 'connectionProfile' | 'portForward';

export type AppHostToolKind = 'overview' | 'quickActions' | 'portForward';

export interface ConnectionProfileDraft {
  readonly name?: string;
  readonly host: string;
  readonly port?: number;
  readonly username?: string;
  readonly group?: string;
  readonly tags?: readonly string[];
  readonly notes?: string;
}

export interface PortForwardRuleDraft {
  readonly profileId: string;
  readonly name: string;
  readonly kind: PortForwardKind;
  readonly localPort: number;
  readonly remoteHost?: string;
  readonly remotePort?: number;
  readonly autoStart?: boolean;
}

export type AppUiAction =
  | {
      readonly type: 'navigateSection';
      readonly section: AppSection;
      readonly workbenchTab?: WorkbenchTab;
    }
  | {
      readonly type: 'navigateSettings';
      readonly settingsSection: SettingsSection;
    }
  | {
      readonly type: 'focusTerminal';
      readonly terminalSessionId: string;
    }
  | {
      readonly type: 'connectTerminalProfile';
      readonly profileId: string;
      readonly initialDirectory?: string;
    }
  | {
      readonly type: 'openLocalTerminal';
    }
  | {
      readonly type: 'openSftpPath';
      readonly profileId: string;
      readonly path: string;
      readonly side?: 'remote' | 'local';
    }
  | {
      readonly type: 'openHostTool';
      readonly profileId: string;
      readonly tool: AppHostToolKind;
    }
  | {
      readonly type: 'openAgentSession';
      readonly agentSessionId: string;
    }
  | {
      readonly type: 'prefillAgentPrompt';
      readonly prompt: string;
      readonly profileId?: string;
    }
  | {
      readonly type: 'openProposalDraft';
      readonly proposalId: string;
      readonly kind: AppProposalKind;
      readonly draft: Record<string, unknown>;
    };

export interface DeepLinkDispatch {
  readonly actionId: string;
  readonly action: AppUiAction;
}

export interface AppActionDispatchedData {
  readonly actionId: string;
  readonly callId: string;
  readonly action: AppUiAction;
  readonly requiresFocus: boolean;
}

export interface AppActionCardData {
  readonly cardId: string;
  readonly callId: string;
  readonly kind: AppActionCardKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly action: AppUiAction;
}

export interface AppActionProposalRequestedData {
  readonly proposalId: string;
  readonly callId: string;
  readonly kind: AppProposalKind;
  readonly summary: string;
  readonly draft: Record<string, unknown>;
}

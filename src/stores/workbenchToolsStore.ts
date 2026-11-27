import { create } from 'zustand';
import type { PortForwardKind } from '@/types';

export interface PortForwardInitialDraft {
  readonly name: string;
  readonly kind: PortForwardKind;
  readonly localPort: number;
  readonly remoteHost?: string;
  readonly remotePort?: number;
  readonly autoStart?: boolean;
}

export interface PendingPortForwardDraft {
  readonly token: number;
  readonly profileId: string;
  readonly draft: PortForwardInitialDraft;
}

interface WorkbenchToolsState {
  portForwardProfileId: string;
  quickActionsProfileId: string;
  overviewProfileId: string | null;
  pendingPortForwardDraft: PendingPortForwardDraft | null;
  selectPortForwardProfile: (profileId: string) => void;
  selectQuickActionsProfile: (profileId: string) => void;
  openHostOverview: (profileId: string) => void;
  closeHostOverview: () => void;
  requestPortForwardDraft: (profileId: string, draft: PortForwardInitialDraft) => void;
  consumePortForwardDraft: (token: number) => void;
}

let nextDraftToken = 1;

export const useWorkbenchToolsStore = create<WorkbenchToolsState>()((set) => ({
  portForwardProfileId: 'all',
  quickActionsProfileId: 'all',
  overviewProfileId: null,
  pendingPortForwardDraft: null,

  selectPortForwardProfile: (portForwardProfileId) => set({ portForwardProfileId }),
  selectQuickActionsProfile: (quickActionsProfileId) => set({ quickActionsProfileId }),
  openHostOverview: (overviewProfileId) => set({ overviewProfileId }),
  closeHostOverview: () => set({ overviewProfileId: null }),
  requestPortForwardDraft: (profileId, draft) => set({
    portForwardProfileId: profileId,
    pendingPortForwardDraft: {
      token: nextDraftToken++,
      profileId,
      draft,
    },
  }),
  consumePortForwardDraft: (token) => set((state) => (
    state.pendingPortForwardDraft?.token === token
      ? { pendingPortForwardDraft: null }
      : state
  )),
}));

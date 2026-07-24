import { create } from 'zustand';

export interface KeychainKeyPromptRequest {
  profileId: string;
  host: string;
  username: string;
}

export type KeychainKeyPromptResult =
  | { kind: 'key'; keyId: string }
  | null;

interface PendingPrompt {
  request: KeychainKeyPromptRequest;
  resolve: (result: KeychainKeyPromptResult) => void;
}

interface KeychainKeyPromptState {
  pending: PendingPrompt | null;
  requestKey: (request: KeychainKeyPromptRequest) => Promise<KeychainKeyPromptResult>;
  resolveKey: (result: KeychainKeyPromptResult) => void;
}

export const useKeychainKeyPromptStore = create<KeychainKeyPromptState>()((set, get) => ({
  pending: null,

  requestKey: async (request) => {
    const existing = get().pending;
    if (existing) {
      existing.resolve(null);
    }

    return new Promise<KeychainKeyPromptResult>((resolve) => {
      set({
        pending: {
          request,
          resolve,
        },
      });
    });
  },

  resolveKey: (result) => {
    const pending = get().pending;
    if (!pending) return;
    pending.resolve(result);
    set({ pending: null });
  },
}));

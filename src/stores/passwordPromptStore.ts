import { create } from 'zustand';

export interface PasswordPromptRequest {
  profileId: string;
  host: string;
  username: string;
}

export interface PasswordPromptResult {
  password: string;
}

interface PendingPrompt {
  request: PasswordPromptRequest;
  resolve: (result: PasswordPromptResult | null) => void;
}

interface PasswordPromptState {
  pending: PendingPrompt | null;
  requestPassword: (request: PasswordPromptRequest) => Promise<PasswordPromptResult | null>;
  resolvePassword: (result: PasswordPromptResult | null) => void;
}

export const usePasswordPromptStore = create<PasswordPromptState>()((set, get) => ({
  pending: null,

  requestPassword: async (request) => {
    const existing = get().pending;
    if (existing) {
      existing.resolve(null);
    }

    return new Promise<PasswordPromptResult | null>((resolve) => {
      set({
        pending: {
          request,
          resolve,
        },
      });
    });
  },

  resolvePassword: (result) => {
    const pending = get().pending;
    if (!pending) return;
    pending.resolve(result);
    set({ pending: null });
  },
}));

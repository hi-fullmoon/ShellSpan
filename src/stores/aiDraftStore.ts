import { create } from 'zustand';

interface AiDraftState {
  readonly drafts: Readonly<Record<string, string>>;
  saveDraft: (owner: string, text: string) => void;
}

/** Unsent text survives panel unmounts; session/workspace keys keep drafts separate. */
export const useAiDraftStore = create<AiDraftState>()((set) => ({
  drafts: {},
  saveDraft: (owner, text) => set((state) => {
    if ((state.drafts[owner] ?? '') === text) return state;
    const drafts = { ...state.drafts };
    if (text) drafts[owner] = text;
    else delete drafts[owner];
    return { drafts };
  }),
}));

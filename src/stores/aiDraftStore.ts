import { create } from 'zustand';

interface AiDraftState {
  readonly drafts: Readonly<Record<string, string>>;
  readonly terminalInsertions: Readonly<Record<string, string>>;
  insertTerminalText: (owner: string, text: string) => void;
  takeTerminalText: (owner: string) => string | undefined;
  saveDraft: (owner: string, text: string) => void;
}

/** Unsent text survives panel unmounts; session/workspace keys keep drafts separate. */
export const useAiDraftStore = create<AiDraftState>()((set) => ({
  drafts: {},
  terminalInsertions: {},
  insertTerminalText: (owner, text) => set(state => ({
    terminalInsertions: { ...state.terminalInsertions, [owner]: [state.terminalInsertions[owner], text].filter(Boolean).join('\n\n') },
  })),
  takeTerminalText: (owner) => {
    let text: string | undefined;
    set(state => {
      text = state.terminalInsertions[owner];
      if (!text) return state;
      const terminalInsertions = { ...state.terminalInsertions };
      delete terminalInsertions[owner];
      return { terminalInsertions };
    });
    return text;
  },
  saveDraft: (owner, text) => set((state) => {
    if ((state.drafts[owner] ?? '') === text) return state;
    const drafts = { ...state.drafts };
    if (text) drafts[owner] = text;
    else delete drafts[owner];
    return { drafts };
  }),
}));

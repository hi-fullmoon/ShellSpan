import { create } from 'zustand';
import type {
  AnswerQuestionInput,
  QuestionAnswer,
} from '@/types/agent-question';

interface Draft {
  readonly answers: readonly QuestionAnswer[];
  readonly submission?: AnswerQuestionInput;
}
interface QuestionDraftState {
  readonly drafts: Readonly<Record<string, Draft>>;
  setDraft(key: string, draft: Draft): void;
  clear(key: string): void;
}

/** Ephemeral drafts only; accepted answers come from committed Session events. */
export const useAgentQuestionStore = create<QuestionDraftState>((set) => ({
  drafts: {},
  setDraft: (key, draft) =>
    set((state) => ({
      drafts: {
        ...Object.fromEntries(
          Object.entries(state.drafts)
            .filter(([id]) => id !== key)
            .slice(-31),
        ),
        [key]: draft,
      },
    })),
  clear: (key) =>
    set((state) => ({
      drafts: Object.fromEntries(
        Object.entries(state.drafts).filter(([id]) => id !== key),
      ),
    })),
}));

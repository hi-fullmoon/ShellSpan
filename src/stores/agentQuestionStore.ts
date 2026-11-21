import { create } from 'zustand';
import type { QuestionSubmissionIssue } from '@/lib/ai/question-submission';
import type {
  AnswerQuestionInput,
  QuestionAnswer,
} from '@/types/agent-question';

interface Draft {
  readonly answers: readonly QuestionAnswer[];
  readonly submission?: AnswerQuestionInput;
  readonly issue?: QuestionSubmissionIssue;
}

export interface ManualHandoffControl {
  readonly questionKey: string;
  readonly pending: boolean;
  readonly complete: () => void;
  readonly openFeedback: () => void;
}

interface QuestionDraftState {
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly handoffControls: Readonly<Record<string, ManualHandoffControl>>;
  setDraft(key: string, draft: Draft): void;
  clear(key: string): void;
  setHandoffControl(agentSessionId: string, control: ManualHandoffControl): void;
  clearHandoffControl(agentSessionId: string, questionKey: string): void;
}

/** Ephemeral drafts only; accepted answers come from committed Session events. */
export const useAgentQuestionStore = create<QuestionDraftState>((set) => ({
  drafts: {},
  handoffControls: {},
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
  setHandoffControl: (agentSessionId, control) =>
    set((state) => ({
      handoffControls: {
        ...state.handoffControls,
        [agentSessionId]: control,
      },
    })),
  clearHandoffControl: (agentSessionId, questionKey) =>
    set((state) => {
      if (state.handoffControls[agentSessionId]?.questionKey !== questionKey) return state;
      return {
        handoffControls: Object.fromEntries(
          Object.entries(state.handoffControls).filter(([id]) => id !== agentSessionId),
        ),
      };
    }),
}));

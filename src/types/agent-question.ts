export interface AgentUserAction {
  readonly instructions: string;
  readonly verification_command: string;
}

export type UserActionResponse = 'completed' | 'change_plan' | 'cancelled';

export interface AgentQuestion {
  readonly id: string;
  readonly question: string;
  readonly input_kind?: 'non_sensitive';
  readonly header?: string;
  readonly options?: readonly {
    readonly label: string;
    readonly description?: string;
    readonly user_action?: AgentUserAction;
  }[];
  readonly multi_select: boolean;
  readonly decision_key?: string;
  readonly decision_context?: string;
  readonly user_action?: AgentUserAction;
}

export interface QuestionIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly questionRequestId: string;
}

export interface QuestionAnswer {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

export interface AnswerQuestionInput {
  readonly identity: QuestionIdentity;
  readonly clientOperationId: string;
  readonly answers: readonly QuestionAnswer[];
  readonly action?: UserActionResponse;
  readonly actionNote?: string;
}

export interface AgentQuestionView {
  readonly identity: QuestionIdentity;
  readonly questions: readonly AgentQuestion[];
  readonly status: 'pending' | 'answered' | 'cancelled';
  readonly answers: readonly QuestionAnswer[];
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly timestamp: string;
  readonly actionResponse?: UserActionResponse;
  readonly actionNote?: string;
}

/** A plan selection stays pending until its separate user operation is settled. */
export function pendingUserAction(question: AgentQuestionView): AgentUserAction | undefined {
  if (question.status !== 'pending' || question.actionResponse) return undefined;
  const item = question.questions[0];
  if (item?.user_action) return item.user_action;
  const answer = question.answers.find((a) => a.id === item?.id);
  if (answer?.custom) return undefined;
  return item?.options?.find((option) => answer?.selected.includes(option.label))?.user_action;
}

export function questionKey(identity: QuestionIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.turnId,
    identity.stepId,
    identity.requestId,
    identity.callId,
    identity.questionRequestId,
  ]);
}

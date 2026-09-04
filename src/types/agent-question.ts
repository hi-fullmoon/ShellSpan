export interface AgentQuestion {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multi_select: boolean;
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
}

export interface AgentQuestionView {
  readonly identity: QuestionIdentity;
  readonly questions: readonly AgentQuestion[];
  readonly status: 'pending' | 'answered' | 'cancelled';
  readonly answers: readonly QuestionAnswer[];
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly timestamp: string;
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

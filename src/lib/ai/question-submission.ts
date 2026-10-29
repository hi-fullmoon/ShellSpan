import type { LocaleKey } from '@/locales';
import { questionKey, type AnswerQuestionInput } from '@/types/agent-question';
import { redactSensitiveValue, redactTerminalSecrets } from '@/lib/terminal/terminal-output-buffer';
import type { AiSessionView } from './session-adapter';
import type { AiConversationNode } from './conversation-node';

export type QuestionSubmissionReason = 'unconfirmed' | 'confirmation' | 'pending' | 'offline'
  | 'recovery' | 'cancelled' | 'ended' | 'inactive' | 'conflict' | 'model' | 'invalid';

export interface QuestionSubmissionIssue {
  readonly reason: QuestionSubmissionReason;
  readonly detail: string;
  readonly retry: boolean;
  readonly editable: boolean;
}

export class QuestionSubmissionError extends Error {
  readonly issue: QuestionSubmissionIssue;
  constructor(issue: QuestionSubmissionIssue) {
    const safe = { ...issue, detail: diagnostic(issue.detail) };
    super(safe.detail || safe.reason);
    this.issue = safe;
    this.name = 'QuestionSubmissionError';
  }
}

const invalidAnswers = new Set([
  'answer every question exactly once', 'duplicate answer id', 'unknown answer id',
  'too many selected options', 'unknown or duplicate selected option',
  'single-select question has multiple answers', 'blank answers cannot be submitted',
  'question text is empty or outside byte limits', 'question payload exceeds 32768 bytes',
]);

function diagnostic(error: unknown): string {
  if (error == null) return '';
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string') message = error;
  else {
    try { message = JSON.stringify(redactSensitiveValue(error)) ?? String(error); }
    catch { message = String(error); }
  }
  return redactTerminalSecrets(message).slice(0, 4096);
}

export function questionIssue(reason: QuestionSubmissionReason, detail = ''): QuestionSubmissionIssue {
  return {
    reason, detail: diagnostic(detail),
    retry: ['unconfirmed', 'confirmation', 'pending', 'offline', 'model'].includes(reason),
    editable: reason === 'invalid',
  };
}

/** Only explicit answer-validation failures prove that this operation was not saved. */
export function questionSubmissionIssue(error: unknown, phase: 'submit' | 'confirm' = 'submit'): QuestionSubmissionIssue {
  if (error instanceof QuestionSubmissionError) return error.issue;
  const detail = diagnostic(error);
  if (phase === 'confirm') return questionIssue('confirmation', detail);
  if (invalidAnswers.has(detail)) return questionIssue('invalid', detail);
  if (detail === 'question cannot bypass required recovery reconciliation') return questionIssue('recovery', detail);
  if (detail === 'question was cancelled') return questionIssue('cancelled', detail);
  if (detail === 'question Session has ended' || detail === 'question was cancelled or Session ended') return questionIssue('ended', detail);
  if (['unknown or stale question identity', 'unknown or cross-Session question', 'Question is no longer active'].includes(detail)) return questionIssue('inactive', detail);
  if (detail === 'question answer conflicts with its committed answer') return questionIssue('conflict', detail);
  if (/credential|api.?key|model selection|INVALID_MODEL_SELECTION|UNKNOWN_ROUTE|UNKNOWN_MODEL|MODEL_CONFIG_UNAVAILABLE|\b401\b|\b403\b|unauthori[sz]ed|provider.*(?:not found|unavailable|not configured|invalid)/i.test(detail)) return questionIssue('model', detail);
  if (/offline|network|connection|disconnected|unreachable|timeout|timed out/i.test(detail)) return questionIssue('offline', detail);
  return questionIssue('unconfirmed', detail);
}

/** A fresh committed view takes precedence over a failed IPC acknowledgement. */
export function reconcileQuestionSubmission(
  input: AnswerQuestionInput,
  view: AiSessionView,
  failure: QuestionSubmissionIssue = questionIssue('pending'),
): QuestionSubmissionIssue | null {
  if (view.summary.id !== input.identity.sessionId) return questionIssue('unconfirmed', failure.detail);
  if (view.committedOperationIds?.includes(input.clientOperationId)) return null;
  // Failed synchronization cannot establish rejection or permit changing a frozen answer.
  if (view.syncError) return questionIssue('confirmation', diagnostic(view.syncError.message));
  const key = questionKey(input.identity);
  const record = view.nodes.flatMap<AiConversationNode>(node => node.kind === 'turnProcess' ? node.children : [node])
    .find(node => node.kind === 'question' && questionKey(node.question.identity) === key);
  if (record?.kind === 'question') {
    if (record.question.status === 'cancelled') return questionIssue('cancelled', failure.detail);
    if (record.question.status === 'answered') return questionIssue('conflict', failure.detail);
  }
  if (view.status === 'cancelled') return questionIssue('cancelled', failure.detail);
  if (view.snapshot.value.ended) return questionIssue('ended', failure.detail);
  if (!view.pendingQuestion || questionKey(view.pendingQuestion.identity) !== key) return questionIssue('inactive', failure.detail);
  if (view.recovery?.status === 'required' || view.recovery?.status === 'reconciling') {
    return questionIssue('recovery', failure.detail || diagnostic(view.recovery.summary));
  }
  return failure;
}

export function questionIssueMessageKey(issue: QuestionSubmissionIssue): LocaleKey {
  return `ai.workspace.question.error.${issue.reason}`;
}

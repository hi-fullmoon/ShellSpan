import type { AgentSessionEvent } from '@/types/agent-session';
import { pendingUserAction, questionKey, type AgentQuestionView } from '@/types/agent-question';
import { createCommittedEventProjection } from './committed-event-projection';

/** Both views consume the same committed identity and answer, never local drafts. */
export function projectQuestions(
  events: readonly AgentSessionEvent[],
): readonly AgentQuestionView[] {
  const projection = createQuestionProjection();
  for (const event of events) projection.apply(event);
  return projection.snapshot();
}

export function createQuestionProjector(): (events: readonly AgentSessionEvent[]) => readonly AgentQuestionView[] {
  return createCommittedEventProjection(createQuestionProjection);
}

export function createQuestionProjection() {
  const questions = new Map<string, AgentQuestionView>();
  const apply = (event: AgentSessionEvent): void => {
    if (event.type === 'question/requested') {
      questions.set(questionKey(event.data.identity), {
        identity: event.data.identity,
        questions: event.data.arguments.questions,
        status: 'pending',
        answers: [],
        firstSeq: event.seq,
        lastSeq: event.seq,
        timestamp: new Date(event.timeUnixMs).toISOString(),
      });
    } else if (
      event.type === 'question/answered' ||
      event.type === 'question/action_answered' ||
      event.type === 'question/cancelled'
    ) {
      const identity =
        event.type !== 'question/cancelled'
          ? event.data.submission.identity
          : event.data.identity;
      const key = questionKey(identity);
      const previous = questions.get(key);
      if (previous) {
        const next: AgentQuestionView = {
          ...previous,
          lastSeq: event.seq,
          status: event.type !== 'question/cancelled' ? 'pending' : 'cancelled',
          answers:
            event.type !== 'question/cancelled'
              ? event.data.submission.answers
              : previous.answers,
          actionResponse: event.type !== 'question/cancelled' ? event.data.submission.action : previous.actionResponse,
        };
        questions.set(key, next.status === 'cancelled' || pendingUserAction(next)
          ? next : { ...next, status: 'answered' });
      }
    }
  };
  return { apply, get: (key: string) => questions.get(key), snapshot: () => [...questions.values()] };
}

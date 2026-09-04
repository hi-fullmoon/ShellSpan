import type { AgentSessionEvent } from '@/types/agent-session';
import { questionKey, type AgentQuestionView } from '@/types/agent-question';

/** Both views consume the same committed identity and answer, never local drafts. */
export function projectQuestions(
  events: readonly AgentSessionEvent[],
): readonly AgentQuestionView[] {
  const questions = new Map<string, AgentQuestionView>();
  for (const event of events) {
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
      event.type === 'question/cancelled'
    ) {
      const identity =
        event.type === 'question/answered'
          ? event.data.submission.identity
          : event.data.identity;
      const key = questionKey(identity);
      const previous = questions.get(key);
      if (previous)
        questions.set(key, {
          ...previous,
          lastSeq: event.seq,
          status: event.type === 'question/answered' ? 'answered' : 'cancelled',
          answers:
            event.type === 'question/answered'
              ? event.data.submission.answers
              : [],
        });
    }
  }
  return [...questions.values()];
}

import { describe, expect, it } from 'vitest';
import { projectQuestions } from '../question-projection';
import { projectAgentChatNodes } from '../conversation-projection';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import {
  agentSessionEventFixture,
  sessionEvent,
} from '@/test/fixtures/agent-session';
import { invokeAnswerAgentRuntimeQuestion } from '@/lib/ipc/tauri';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import type { AnswerQuestionInput } from '@/types/agent-question';

const identity = {
  sessionId: 'session-fixture',
  turnId: 'turn-01',
  stepId: 'step-01',
  requestId: 'request-01',
  callId: 'question-call',
  questionRequestId: 'question-id',
};
const base = agentSessionEventFixture.slice(0, 10);
const requested = sessionEvent(base.length, {
  type: 'question/requested',
  turnId: identity.turnId,
  stepId: identity.stepId,
  data: {
    identity,
    arguments: {
      questions: [{ id: 'choice', question: 'Choose?', multi_select: false }],
    },
    provider: {
      routeId: 'fixture',
      modelId: 'fixture',
    },
  },
});
const input: AnswerQuestionInput = {
  identity,
  clientOperationId: 'operation',
  answers: [{ id: 'choice', selected: [], custom: 'answer' }],
};
const answered = sessionEvent(base.length + 1, {
  type: 'question/answered',
  turnId: identity.turnId,
  stepId: identity.stepId,
  data: { submission: input, fingerprint: '0'.repeat(64) },
});

describe('Stage 6A committed question projections and IPC', () => {
  it('keeps one stable top-level chat question outside the process and one Activity identity on replay', () => {
    const events = [...base, requested, answered];
    const chat = projectAgentChatNodes(events);
    const pending = projectAgentChatNodes([...base, requested]).find(
      (n) => n.kind === 'question',
    );
    const question = chat.find((n) => n.kind === 'question');
    expect(question?.key).toBe(pending?.key);
    expect(question).toMatchObject({
      question: { status: 'answered', answers: input.answers },
    });
    expect(chat.filter((n) => n.kind === 'question')).toHaveLength(1);
    expect(projectAgentChatNodes(events)).toEqual(chat);
    const activity = projectAgentActivity(events).nodes.filter(
      (n) => n.kind === 'question',
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ status: 'completed' });
    expect(projectQuestions(events.slice(base.length))).toEqual(
      projectQuestions(events),
    );
  });

  it('represents cancellation without manufacturing an answer and ignores orphan partial answers', () => {
    const cancelled = sessionEvent(base.length + 1, {
      type: 'question/cancelled',
      turnId: identity.turnId,
      stepId: identity.stepId,
      data: { identity },
    });
    expect(projectQuestions([...base, requested, cancelled])[0]).toMatchObject({
      status: 'cancelled',
      answers: [],
    });
    expect(projectQuestions([answered])).toEqual([]);
  });

  it('sends the exact identity and operation to the registered answer command', async () => {
    const calls: unknown[] = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      return {};
    });
    try {
      await invokeAnswerAgentRuntimeQuestion(input);
      expect(calls).toEqual([
        { command: 'agent_runtime_answer_question', args: { input } },
      ]);
    } finally {
      clearMocks();
    }
  });
});

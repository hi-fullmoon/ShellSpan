import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { projectAgentInbox } from '@/lib/ai/agent-session-adapter';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionEventFixture, sessionEvent } from '@/test/fixtures/agent-session';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('Composer queue visibility during submission', () => {
  it.each([
    { name: 'new conversation', sessionId: null, running: false, steer: false },
    { name: 'idle conversation', sessionId: 'session-fixture', running: false, steer: false },
    { name: 'running queue', sessionId: 'session-fixture', running: true, steer: false },
    { name: 'running steer', sessionId: 'session-fixture', running: true, steer: true },
  ])('keeps the queue stable from Enter through claim in a $name', ({ sessionId, running, steer }) => {
    let events = [...agentSessionEventFixture.slice(0, sessionId ? 6 : 3)];
    if (sessionId && !running) {
      events.push(sessionEvent(events.length, {
        type: 'turn/end', turnId: 'turn-1', data: { reason: 'completed' },
      }));
    }
    let composer = createAiComposerState({
      sessionId,
      runtimeStatus: running ? 'running' : 'idle',
      preferredBusyMode: steer ? 'steer' : 'queue',
      draft: 'Explain this error',
    });
    const seat = () => (
      <AiComposerSeat
        phase="active"
        status={composer.runtimeStatus}
        composerState={composer}
        inbox={projectAgentInbox(events)}
        taskSteps={[{ id: 'inspect', title: 'Inspect the error', status: 'inProgress' }]}
        onSubmitGesture={(gesture, accelerated) => {
          composer = reduceAiComposer(composer, {
            type: 'submit.requested', gesture, accelerated,
            clientOperationId: 'new-input', now: 100, hasProvider: true, canCreateSession: true,
          }).state;
        }}
      />
    );
    const { rerender } = render(seat());
    const expectQueue = (visible: boolean) => {
      expect(Boolean(screen.queryByRole('region', { name: 'Queued input' }))).toBe(visible);
      expect(screen.getByRole('button', { name: 'Toggle 1 tasks' })).toBeVisible();
    };
    expectQueue(false);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    rerender(seat());
    expect(screen.getByRole('textbox').textContent).toBe('');
    expectQueue(running);

    const mode = composer.pendingSubmissions[0].mode;
    composer = reduceAiComposer(composer, {
      type: 'submit.accepted',
      receipt: { sessionId: 'session-fixture', clientOperationId: 'new-input', mode },
    }).state;
    rerender(seat());
    expectQueue(running);

    const lane = steer ? 'nextStep' : 'nextTurn';
    const messages = [{
      messageId: 'runtime-message', clientSubmissionId: 'new-input', content: 'Explain this error',
      source: { kind: 'user' as const, label: 'User', producerId: 'shellspan-user' },
    }];
    events.push(sessionEvent(events.length, {
      type: 'agent/inbox/spliced', data: { operation: 'enqueued', lane, messages },
    }));
    rerender(seat());
    expectQueue(running);

    composer = reduceAiComposer(composer, {
      type: 'submit.committed', clientOperationId: 'new-input',
    }).state;
    rerender(seat());
    expectQueue(running);

    if (running) {
      events.push(sessionEvent(events.length, {
        type: 'turn/end', turnId: 'turn-1', data: { reason: 'completed' },
      }));
      rerender(seat());
      expectQueue(true);
    }

    events.push(sessionEvent(events.length, {
      type: 'agent/inbox/spliced', data: { operation: 'claimed', lane, messages },
    }));
    rerender(seat());
    expectQueue(false);
  });
});

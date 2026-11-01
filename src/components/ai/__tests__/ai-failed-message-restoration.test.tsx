import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiWorkspaceController } from '../workspace/ai-workspace-controller';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';
import { sharedAgentSessionAdapter, submissionMemoryFor } from '@/lib/ai/submission-memory';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const context = { key: 'ask:workbench' };
const memory = submissionMemoryFor(sharedAgentSessionAdapter());

afterEach(() => {
  cleanup();
  memory.remember(context, createAiComposerState());
  memory.close(context);
});

// Exercise actual application memory, reducer and controller without replacing an adapter.
it.each(['zh-CN', 'en-US'] as const)('restores failed messages after real controller unmounts in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const recording = taskTokenBudgetView();
  let state = createAiComposerState();
  for (const [index, failure] of [new AiPreparationTimeoutError(), new AiAdmissionUnconfirmedError()].entries()) {
    const clientOperationId = `${recording.summary.id}:${index}`;
    state = reduceAiComposer(state, { type: 'submit.requested', clientOperationId,
      content: recording.snapshot.value.header.goal, gesture: 'primary', accelerated: false,
      now: recording.snapshot.value.header.createdAtUnixMs + index, hasProvider: true, canCreateSession: true }).state;
    state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId,
      error: normalizeAiSessionError(failure) }).state;
  }
  memory.remember(context, state);
  memory.close(context);
  for (let visit = 0; visit < 2; visit++) {
    const panel = render(<AiWorkspaceController scope="workbench" />);
    await waitFor(() => expect(panel.container.querySelectorAll('[data-slot="ai-workspace-content"] [data-ai-failed-draft]')).toHaveLength(2));
    expect(screen.getAllByText(recording.snapshot.value.header.goal)).toHaveLength(2);
    expect(screen.getAllByText(t('ai.workspace.messageNotSent'))).toHaveLength(1);
    expect(screen.getAllByText(t('ai.workspace.messageUnconfirmed'))).toHaveLength(1);
    expect(panel.container.querySelector('[data-slot="ai-retained-failed-drafts"]')).toBeNull();
    expect(panel.container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
    expect(screen.queryByRole('status', { name: t('ai.workspace.messagePending') })).toBeNull();
    expect(memory.reopen(context.key)?.state.failedDrafts.map(draft => draft.id)).toEqual(state.failedDrafts.map(draft => draft.id));
    await act(async () => panel.unmount());
  }
});

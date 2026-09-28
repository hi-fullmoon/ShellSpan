import { useReducer } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import userEvent from '@/test/composer-editor-user';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { initI18n } from '@/locales';
import { useToastStore } from '@/stores/toastStore';
import { useAppStore } from '@/stores/appStore';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiConversation } from '../workspace/ai-conversation';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); useToastStore.setState({ toasts: [] }); });

it('offers a retry for the original failed identity without replacing a newer draft', async () => {
  const started = reduceAiComposer(createAiComposerState({ draft: 'first message' }), {
    type: 'submit.requested', gesture: 'keyboard', accelerated: false,
    clientOperationId: 'original-operation', now: 1, hasProvider: true, canCreateSession: true,
  }).state;
  const editing = reduceAiComposer(started, { type: 'draft.changed', value: 'newer draft' }).state;
  const failed = reduceAiComposer(editing, { type: 'submit.failed', clientOperationId: 'original-operation',
    error: { kind: 'offline', message: 'Disconnected', retryable: true } }).state;
  const retried: string[] = [];
  render(<AiWorkspaceErrorNotices composerState={failed} onRetryFailedDraft={id => retried.push(id)} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(retried).toEqual(['original-operation']);
  expect(failed.draft).toBe('newer draft');
});

it.each(['keyboard', 'primary'] as const)('keeps editing the next draft after a %s submission', async gesture => {
  function Composer() {
    const [state, dispatch] = useReducer(
      (previous: ReturnType<typeof createAiComposerState>, event: Parameters<typeof reduceAiComposer>[1]) => reduceAiComposer(previous, event).state,
      undefined, () => createAiComposerState(),
    );
    return <AiComposerSeat phase="active" status={state.runtimeStatus} composerState={state}
      onDraftChange={value => dispatch({ type: 'draft.changed', value })}
      onSubmitGesture={(inputGesture, accelerated = false) => dispatch({
        type: 'submit.requested', gesture: inputGesture, accelerated,
        clientOperationId: crypto.randomUUID(), now: Date.now(), hasProvider: true, canCreateSession: true,
      })}
    />;
  }
  const user = userEvent.setup();
  render(<Composer />);
  const editor = screen.getByRole('textbox');
  await user.type(editor, 'Explain the current directory');
  if (gesture === 'keyboard') await user.keyboard('{Enter}');
  else await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(editor.textContent).toBe(''));
  expect(editor).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await user.paste('Also explain the scripts');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  await user.keyboard('{Enter}{Enter}');
  expect(editor.textContent).toBe('');
  expect(editor).toHaveFocus();
  expect(useToastStore.getState().toasts.map(toast => toast.message))
    .toEqual([]);
});

it('explains blocked Ask submission once and preserves the draft until the reply finishes', async () => {
  const user = userEvent.setup();
  const submissions: string[] = [];
  const props = { phase: 'active' as const, mode: 'ask' as const,
    defaultDraft: 'Explain the result', onSubmit: (text: string) => { submissions.push(text); } };
  const { rerender } = render(<AiComposerSeat {...props} status="running" />);
  await user.click(screen.getByRole('textbox'));
  await user.keyboard('{Enter}{Enter}');
  expect(submissions).toEqual([]);
  expect(screen.getByRole('textbox')).toHaveTextContent('Explain the result');
  expect(useToastStore.getState().toasts).toHaveLength(1);
  expect(useToastStore.getState().toasts[0].message).toContain('Your draft is preserved');
  rerender(<AiComposerSeat {...props} status="idle" />);
  await user.keyboard('{Enter}');
  expect(submissions).toEqual(['Explain the result']);
});

it('keeps Agent submission and runtime startup free of a processing row', () => {
  const props = { nodes: [], status: 'idle' as const, throughSeq: null };
  const { container, rerender } = render(<AiConversation {...props} pending />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  rerender(<AiConversation {...props} status="running" />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  rerender(<AiConversation {...props} />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
});

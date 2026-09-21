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

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); useToastStore.setState({ toasts: [] }); });

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
  expect(screen.getByRole('button', { name: 'Sending' })).toBeDisabled();
  await user.paste('Also explain the scripts');
  await user.keyboard('{Enter}{Enter}');
  expect(editor).toHaveTextContent('Also explain the scripts');
  expect(editor).toHaveFocus();
  expect(useToastStore.getState().toasts.map(toast => toast.message))
    .toEqual(['The previous input is still being submitted.']);
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

it('keeps the Agent processing indicator mounted from submission through runtime startup', () => {
  const props = { nodes: [], status: 'idle' as const, throughSeq: null };
  const { container, rerender } = render(<AiConversation {...props} pending />);
  const indicator = container.querySelector('[data-ai-running-indicator]');
  expect(indicator).toHaveTextContent('Working…');
  rerender(<AiConversation {...props} status="running" />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBe(indicator);
  rerender(<AiConversation {...props} />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
});

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
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); useToastStore.setState({ toasts: [] }); });

it.each(['en-US', 'zh-CN'] as const)('offers retry for an unsent preparation timeout in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const started = reduceAiComposer(createAiComposerState({ draft: 'original' }), {
    type: 'submit.requested', gesture: 'keyboard', accelerated: false, clientOperationId: 'original',
    now: 1, hasProvider: true, canCreateSession: true,
  }).state;
  const error = normalizeAiSessionError(new AiPreparationTimeoutError());
  expect(error.deliveryUnknown).toBeUndefined();
  expect(error.retryable).toBe(true);
  const failed = reduceAiComposer(started, { type: 'submit.failed', clientOperationId: 'original', error }).state;
  const { container } = render(<AiWorkspaceErrorNotices composerState={failed} onRetryFailedDraft={() => {}} />);
  expect(screen.getByText(locale === 'en-US'
    ? 'Message preparation timed out before sending. Check the terminal connection and retry.'
    : '消息准备超时，尚未发送。请检查终端连接后重试。')).toBeVisible();
  expect(screen.getByRole('button', { name: locale === 'en-US' ? 'Retry' : '重试' })).toBeVisible();
  expect(container.textContent).not.toContain('AGENT_PREPARATION_TIMEOUT');
});

it.each(['en-US', 'zh-CN'] as const)('distinguishes unconfirmed receipt from failed delivery in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const started = reduceAiComposer(createAiComposerState({ draft: 'original' }), {
    type: 'submit.requested', gesture: 'keyboard', accelerated: false, clientOperationId: 'original',
    now: 1, hasProvider: true, canCreateSession: true,
  }).state;
  const failed = reduceAiComposer(started, { type: 'submit.failed', clientOperationId: 'original',
    error: normalizeAiSessionError(new AiAdmissionUnconfirmedError()) }).state;
  const { container } = render(<AiWorkspaceErrorNotices composerState={failed} onRetryFailedDraft={() => {}} />);
  expect(screen.getByText(locale === 'en-US' ? 'Receipt unconfirmed' : '接收结果未确认')).toBeVisible();
  expect(screen.getByRole('button', { name: locale === 'en-US' ? 'Check and retry' : '核对并重试' })).toBeVisible();
  expect(container.querySelectorAll('[data-ai-error-notice]')).toHaveLength(1);
  expect(container.textContent).not.toContain('AGENT_ADMISSION_UNCONFIRMED');
  expect(container.textContent).not.toContain(locale === 'en-US' ? 'Failed draft' : '失败草稿');
});

it('labels the next send as queued while earlier admissions are waiting', () => {
  let state = createAiComposerState();
  for (const id of ['first', 'second']) {
    state = reduceAiComposer(state, { type: 'submit.requested', content: id,
      gesture: 'keyboard', accelerated: false, clientOperationId: id, now: 1,
      hasProvider: true, canCreateSession: true }).state;
  }
  state = reduceAiComposer(state, { type: 'draft.changed', value: 'new draft' }).state;
  const { container } = render(<AiComposerSeat phase="active" status="idle" composerState={state} />);
  expect(screen.getByRole('button', { name: 'Queue for next turn' })).toBeInTheDocument();
  expect(screen.getByText('Waiting to send')).toBeVisible();
  expect(container.querySelector('.ai-queue-row [data-slot="spinner"]')).toBeNull();
});

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
  expect(screen.getByRole('button', { name: 'Queue for next turn' })).toBeDisabled();
  await user.paste('Also explain the scripts');
  expect(screen.getByRole('button', { name: 'Queue for next turn' })).toBeEnabled();
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
  expect(container.querySelector('[data-ai-processing]')).toBeNull();
  rerender(<AiConversation {...props} status="running" />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('[data-ai-processing]')).toBeNull();
  rerender(<AiConversation {...props} />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
});

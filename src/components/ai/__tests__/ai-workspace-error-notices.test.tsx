import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@/tests/composer-editor-user';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import type { AiFailedDraftRecoveryProps } from '../workspace/ai-failed-draft-recovery';
import { withOptimisticConversationNodes, withRetainedFailedSubmissions } from '@/lib/ai/optimistic-submission';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { taskTokenBudgetView } from '@/tests/fixtures/task-token-budget';

afterEach(cleanup);
beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });

function FailedMessageWorkspace(props: AiFailedDraftRecoveryProps) {
  const state = props.composerState ?? createAiComposerState();
  const submissions = withRetainedFailedSubmissions([], state, 'ask:workbench');
  return <AiWorkspaceRoot scope="workbench" view={null} {...props}
    pendingNodes={withOptimisticConversationNodes([], submissions, 'ask:workbench', state.sessionId)} />;
}

describe('localized workspace errors', () => {
  it.each([false, true])('keeps image-only failed messages visible when the receipt is unknown=%s', async deliveryUnknown => {
    const state = createAiComposerState({ failedDrafts: [{
      id: 'image-only', content: '', hasImages: true, mode: 'nextTurn',
      error: normalizeAiSessionError(deliveryUnknown ? new AiAdmissionUnconfirmedError() : new AiPreparationTimeoutError()),
    }] });
    const { container } = render(<FailedMessageWorkspace composerState={state} onRetryFailedDraft={() => undefined} />);
    expect(screen.getByText(t('ai.workspace.images.attachments'))).toBeVisible();
    expect(container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
    expect(container.querySelectorAll('[data-ai-failed-draft]')).toHaveLength(1);
  });

  it('retains distinct operation failures even when their text matches a failed send', async () => {
    await initI18n('en-US');
    const error = normalizeAiSessionError(new AiPreparationTimeoutError());
    const { container } = render(<FailedMessageWorkspace composerState={createAiComposerState({
      lastError: { ...error }, failedDrafts: [{ id: error.message, content: error.message, mode: 'nextTurn', error }],
    })} />);
    expect(container.querySelectorAll('[data-ai-error-notice]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ai-failed-draft]')).toHaveLength(1);
  });

  it('restores multiple retained sends in the transcript without composer lists or Alert cards', async () => {
    await initI18n('en-US');
    const view = taskTokenBudgetView();
    const error = normalizeAiSessionError(new AiPreparationTimeoutError());
    let state = createAiComposerState({ sessionId: view.summary.id });
    for (let index = 0; index < 3; index++) {
      const clientOperationId = `${view.summary.id}:${index}`;
      state = reduceAiComposer(state, {
        type: 'submit.requested', clientOperationId, content: view.snapshot.value.header.goal,
        gesture: 'primary', accelerated: false, now: view.snapshot.value.header.createdAtUnixMs + index,
        hasProvider: true, canCreateSession: true,
      }).state;
      state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId, error }).state;
    }
    const failedDrafts = state.failedDrafts;
    expect(failedDrafts).toHaveLength(3);
    const retried: string[] = [];
    const { container } = render(<FailedMessageWorkspace composerState={state}
      onRetryFailedDraft={id => retried.push(id)} />);
    expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-ai-failed-draft]')).toHaveLength(failedDrafts.length);
    expect(container.querySelector('[data-slot="ai-workspace-error-notices"]')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-slot="ai-retained-failed-drafts"]')).toBeNull();
    screen.getAllByRole('button', { name: t('common.retry') }).forEach(button => fireEvent.click(button));
    expect(retried).toEqual(failedDrafts.map(draft => draft.id));
  });

  it.each(['zh-CN', 'en-US'] as const)('localizes recorded system failures while preserving the original draft in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const view = taskTokenBudgetView();
    const error = view.error!;
    const content = view.snapshot.value.header.goal;
    const state = createAiComposerState({ phase: 'error', lastError: error,
      failedDrafts: [{ id: view.summary.id, content, mode: 'nextTurn', error }] });
    render(<FailedMessageWorkspace composerState={state} />);
    const details = screen.getByText(t('ai.workspace.messageNotSent'));
    expect(details).toHaveAttribute('tabindex', '0');
    expect(screen.queryByText(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }))).toBeNull();
    await userEvent.setup().hover(details);
    expect(await screen.findByText(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }))).toBeVisible();
    expect(screen.getByRole('tooltip')).toHaveTextContent(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }));
    expect(details).toHaveAccessibleDescription(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }));
    expect(screen.getByText(content)).toBeVisible();
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();
    expect(state.lastError).toBe(error);
    expect(state.failedDrafts[0].content).toBe(content);
  });
  it.each(['zh-CN', 'en-US'] as const)('renders image errors in %s without changing diagnostics or drafts', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const message = 'IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model';
    const error = { kind: 'unknown' as const, message, retryable: true };
    const state = createAiComposerState({
      phase: 'error', lastError: error,
      failedDrafts: [{ id: 'failed-image', content: message, mode: 'nextTurn', error }],
    });
    const retried: string[] = [];
    const { container } = render(<FailedMessageWorkspace composerState={state} onRetryFailedDraft={id => retried.push(id)} />);
    const retry = screen.getByRole('button', { name: t('common.retry') });
    expect(retry).toHaveClass('size-6', 'shrink-0', 'focus-visible:ring-0', 'focus-visible:bg-accent');
    expect(retry).not.toHaveClass('focus-visible:ring-2');
    expect(retry.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(retry).toHaveTextContent('');
    expect(screen.queryByRole('button', { name: t('ai.workspace.recovery.dismiss') })).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(container.querySelector('[data-slot="alert"]')).toBeNull();
    expect(container.querySelector('[data-slot="ai-retained-failed-drafts"]')).toBeNull();
    expect(retry.closest('[data-slot="ai-workspace-content"]')).not.toBeNull();
    expect(retry.closest('[data-ai-failed-draft]')).toHaveClass('grid', 'items-center', 'gap-x-1');
    expect(retry).not.toHaveClass('border', 'bg-background');
    retry.click();
    expect(retried).toEqual(['failed-image']);
    await userEvent.setup().hover(screen.getByText(t('ai.workspace.messageNotSent')));
    expect(await screen.findByText(t('ai.workspace.images.error.model'))).toBeVisible();
    expect(state.lastError?.message).toBe(message);
    // User-authored draft content is not treated as an error code.
    expect(screen.getByText(message)).toBeVisible();
  });
  it.each([false, true])('keeps sync retry text-only while retrying=%s', async retrying => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    let retries = 0;
    render(<AiWorkspaceErrorNotices
      syncError={{ kind: 'unknown', message: 'sync failed', retryable: true }}
      syncRecovery={{ attempts: 1, retrying }}
      onRetrySync={async () => { retries++; }}
    />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(t(retrying ? 'ai.error.streamSyncRetrying' : 'ai.error.streamSyncRetry'));
    expect(button.querySelector('svg')).toBeNull();
    expect(button).toHaveClass('h-6', 'px-2', 'text-[11px]', 'hover:bg-accent');
    expect(button).not.toHaveClass('border', 'bg-background');
    if (retrying) expect(button).toBeDisabled();
    else expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(retries).toBe(retrying ? 0 : 1);
  });
  it('blocks failed draft retry while stopping', async () => {
    await initI18n('en-US');
    const error = { kind: 'unknown' as const, message: 'Connection failed', retryable: true };
    let retries = 0;
    render(<FailedMessageWorkspace composerState={createAiComposerState({
      phase: 'stopping', failedDrafts: [{ id: 'failed', content: 'original input', mode: 'nextTurn', error }],
    })} onRetryFailedDraft={() => { retries++; }} />);
    const button = screen.getByRole('button', { name: t('common.retry') });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(retries).toBe(0);
  });

  // UI state boundaries only: callbacks record gestures without replacing a service.
  it.each(['zh-CN', 'en-US'] as const)('updates retained failed-draft actions when a child budget expires in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const error = normalizeAiSessionError(new AiPreparationTimeoutError());
    const state = createAiComposerState({ failedDrafts: [{
      id: error.message, content: error.message, mode: 'nextTurn', error,
    }] });
    const retries: string[] = [];
    const props = { composerState: state, onRetryFailedDraft: (id: string) => { retries.push(id); } };
    const form = render(<FailedMessageWorkspace {...props} />);
    const retry = screen.getByRole('button', { name: t('common.retry') });
    expect(retry).toBeEnabled();
    form.rerender(<FailedMessageWorkspace {...props} failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    expect(retry).toBeDisabled();
    expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toBeVisible();
    expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toHaveClass('col-start-2', 'col-span-2');
    expect(retry).toHaveAccessibleDescription(t('ai.error.childRecoveryBudgetExhausted'));
    fireEvent.click(retry);
    expect(retries).toEqual([]);
    expect(screen.getByText(error.message, { exact: true })).toBeVisible();
    expect(state.failedDrafts[0].content).toBe(error.message);
    form.rerender(<FailedMessageWorkspace {...props} />);
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(retries).toEqual([error.message]);
  });

  it.each(['zh-CN', 'en-US'] as const)('only checks unknown receipts after budget expiry and retains unconfirmed drafts in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const error = normalizeAiSessionError(new AiAdmissionUnconfirmedError());
    const state = createAiComposerState({ failedDrafts: [{
      id: error.message, content: error.message, mode: 'nextTurn', error,
    }] });
    let retries = 0;
    let checks = 0;
    let finishCheck!: () => void;
    const checking = new Promise<void>(resolve => { finishCheck = resolve; });
    const props = {
      composerState: state,
      onRetryFailedDraft: () => { retries++; },
      onRetrySync: () => { checks++; return checking; },
    };
    const form = render(<FailedMessageWorkspace {...props} />);
    expect(screen.getByRole('button', { name: t('ai.workspace.retryOriginal') })).toBeEnabled();
    form.rerender(<FailedMessageWorkspace {...props} failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    const check = screen.getByRole('button', { name: t('ai.workspace.checkReceipt') });
    expect(screen.queryByRole('button', { name: t('ai.workspace.retryOriginal') })).not.toBeInTheDocument();
    fireEvent.click(check);
    fireEvent.click(check);
    expect(checks).toBe(1);
    expect(retries).toBe(0);
    expect(check).toBeDisabled();
    expect(check).toHaveAttribute('aria-busy', 'true');
    expect(check).toHaveAccessibleName(t('ai.workspace.messageConfirming'));
    expect(check.querySelector('[data-slot="spinner"]')).not.toBeNull();
    finishCheck();
    await waitFor(() => expect(check).toBeEnabled());
    expect(check).toHaveAccessibleName(t('ai.workspace.checkReceipt'));
    expect(screen.getByText(error.message, { exact: true })).toBeVisible();
    expect(state.failedDrafts[0].content).toBe(error.message);
    form.rerender(<FailedMessageWorkspace {...props} composerState={{ ...state, phase: 'stopping' }}
      failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(checks).toBe(1);
    expect(retries).toBe(0);
  });
});

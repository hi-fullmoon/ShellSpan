import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';

afterEach(cleanup);

describe('localized workspace errors', () => {
  it.each(['zh-CN', 'en-US'] as const)('localizes recorded system failures while preserving the original draft in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const view = taskTokenBudgetView();
    const error = view.error!;
    const content = view.snapshot.value.header.goal;
    const state = createAiComposerState({ phase: 'error', lastError: error,
      failedDrafts: [{ id: view.summary.id, content, mode: 'nextTurn', error }] });
    render(<AiWorkspaceErrorNotices composerState={state} />);
    expect(screen.getByText(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }))).toBeVisible();
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
    let dismissed = false;
    render(<AiWorkspaceErrorNotices composerState={state} onRetryFailedDraft={id => retried.push(id)} onDismissError={() => { dismissed = true; }} />);
    const retry = screen.getByRole('button', { name: t('common.retry') });
    expect(retry).toHaveClass('h-6', 'shrink-0', 'text-[11px]');
    for (const button of screen.getAllByRole('button')) expect(button.querySelector('svg')).toBeNull();
    const dismiss = screen.getByRole('button', { name: t('ai.workspace.recovery.dismiss') });
    expect(dismiss).toHaveTextContent(t('ai.workspace.recovery.dismiss'));
    dismiss.click();
    expect(dismissed).toBe(true);
    expect(retry).not.toHaveClass('border', 'bg-background');
    retry.click();
    expect(retried).toEqual(['failed-image']);
    expect(screen.getByText(t('ai.workspace.images.error.model'))).toBeVisible();
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
    render(<AiWorkspaceErrorNotices composerState={createAiComposerState({
      phase: 'stopping', failedDrafts: [{ id: 'failed', content: 'original input', mode: 'nextTurn', error }],
    })} onRetryFailedDraft={() => { retries++; }} />);
    const button = screen.getByRole('button');
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
    const form = render(<AiWorkspaceErrorNotices {...props} />);
    const retry = screen.getByRole('button', { name: t('common.retry') });
    expect(retry).toBeEnabled();
    form.rerender(<AiWorkspaceErrorNotices {...props} failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    expect(retry).toBeDisabled();
    expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toBeVisible();
    expect(retry).toHaveAccessibleDescription(t('ai.error.childRecoveryBudgetExhausted'));
    fireEvent.click(retry);
    expect(retries).toEqual([]);
    expect(screen.getByText(error.message, { exact: true })).toBeVisible();
    expect(state.failedDrafts[0].content).toBe(error.message);
    form.rerender(<AiWorkspaceErrorNotices {...props} />);
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
    const form = render(<AiWorkspaceErrorNotices {...props} />);
    expect(screen.getByRole('button', { name: t('ai.workspace.retryOriginal') })).toBeEnabled();
    form.rerender(<AiWorkspaceErrorNotices {...props} failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    const check = screen.getByRole('button', { name: t('ai.workspace.checkReceipt') });
    expect(screen.queryByRole('button', { name: t('ai.workspace.retryOriginal') })).not.toBeInTheDocument();
    fireEvent.click(check);
    fireEvent.click(check);
    expect(checks).toBe(1);
    expect(retries).toBe(0);
    expect(check).toBeDisabled();
    expect(check).toHaveAttribute('aria-busy', 'true');
    expect(check).toHaveTextContent(t('ai.workspace.messageConfirming'));
    finishCheck();
    await waitFor(() => expect(check).toBeEnabled());
    expect(check).toHaveTextContent(t('ai.workspace.checkReceipt'));
    expect(screen.getByText(error.message, { exact: true })).toBeVisible();
    expect(state.failedDrafts[0].content).toBe(error.message);
    form.rerender(<AiWorkspaceErrorNotices {...props} composerState={{ ...state, phase: 'stopping' }}
      failedDraftRetryBlockedReason={t('ai.error.childRecoveryBudgetExhausted')} />);
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(checks).toBe(1);
    expect(retries).toBe(0);
  });
});

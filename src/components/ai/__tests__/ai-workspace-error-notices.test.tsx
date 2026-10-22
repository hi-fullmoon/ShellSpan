import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

describe('localized workspace errors', () => {
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
});

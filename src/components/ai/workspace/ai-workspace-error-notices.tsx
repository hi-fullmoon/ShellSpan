import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionError, AiSessionSyncRecovery } from '@/lib/ai/session-adapter';
import { AiErrorNotice } from './ai-error-notice';
import { AiNoticeAction } from './ai-notice-action';
import { AiNoticeTransition } from './ai-notice-transition';

export interface AiWorkspaceErrorNoticesProps {
  readonly composerState?: AiComposerState;
  readonly syncError?: AiSessionError;
  readonly syncRecovery?: AiSessionSyncRecovery;
  readonly onRetrySync?: () => Promise<void>;
  readonly onDismissError?: () => void;
}

/** Input and synchronization errors displayed above the composer. */
export function AiWorkspaceErrorNotices({
  composerState,
  syncError,
  syncRecovery,
  onRetrySync,
  onDismissError,
}: AiWorkspaceErrorNoticesProps): React.ReactNode {
  const { t, locale } = useI18n();
  const drafts = composerState?.failedDrafts ?? [];
  // The reducer retains the same failure in lastError and failedDrafts. Render it once.
  const operationError = composerState?.lastError;
  const showOperationError = operationError && operationError !== syncError
    && !drafts.some(failed => failed.error === operationError);

  return (
    <div
      data-slot="ai-workspace-error-notices"
      className="ai-workspace-error-notices flex w-full min-w-0 shrink-0 flex-col gap-1.5"
    >
      <AiNoticeTransition>
        {syncError ? (
          <AiErrorNotice
            title={t('ai.workspace.recovery.title')}
            action={onRetrySync && <AiNoticeAction
              disabled={syncRecovery?.retrying} aria-busy={syncRecovery?.retrying || undefined}
              onClick={() => { void onRetrySync(); }}>
              {t(syncRecovery?.retrying ? 'ai.error.streamSyncRetrying' : 'ai.error.streamSyncRetry')}
            </AiNoticeAction>}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span>{t((syncRecovery?.attempts ?? 0) >= 3 ? 'ai.error.streamSyncPersistent' : 'ai.error.streamSyncFailed')}</span>
              {syncRecovery && <span className="text-muted-foreground">
                {t('ai.error.streamSyncAttempts', { count: syncRecovery.attempts })}
                {syncRecovery.lastSyncedAt !== undefined && <> · {t('ai.error.streamLastSynced', {
                  time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    .format(syncRecovery.lastSyncedAt),
                })}</>}
              </span>}
            </span>
          </AiErrorNotice>
        ) : null}
      </AiNoticeTransition>
      <AiNoticeTransition>
        {showOperationError ? (
          <AiErrorNotice
            title={t('ai.workspace.recovery.title')}
            action={onDismissError && (
              <AiNoticeAction
                aria-label={t('ai.workspace.recovery.dismiss')}
                onClick={onDismissError}
              >
                {t('ai.workspace.recovery.dismiss')}
              </AiNoticeAction>
            )}
          >
            {aiErrorMessage(operationError.message, t)}
          </AiErrorNotice>
        ) : null}
      </AiNoticeTransition>
    </div>
  );
}

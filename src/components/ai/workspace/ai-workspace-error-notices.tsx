import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionError, AiSessionSyncRecovery } from '@/lib/ai/session-adapter';
import { AiErrorNotice } from './ai-error-notice';
import { AiNoticeTransition } from './ai-notice-transition';

export interface AiWorkspaceErrorNoticesProps {
  readonly composerState?: AiComposerState;
  readonly syncError?: AiSessionError;
  readonly syncRecovery?: AiSessionSyncRecovery;
  readonly onRetrySync?: () => Promise<void>;
  readonly onDismissError?: () => void;
  readonly onRetryFailedDraft?: (id: string) => void;
  readonly failedDraftRetryBlockedReason?: string | null;
}

/** Input and synchronization errors displayed above the composer. */
export function AiWorkspaceErrorNotices({
  composerState,
  syncError,
  syncRecovery,
  onRetrySync,
  onDismissError,
  onRetryFailedDraft,
  failedDraftRetryBlockedReason = null,
}: AiWorkspaceErrorNoticesProps): React.ReactNode {
  const { t, locale } = useI18n();
  const blockedReasonId = useId();
  const checkingReceiptRef = useRef(false);
  const [checkingReceipt, setCheckingReceipt] = useState(false);
  const confirmReceipt = async (): Promise<void> => {
    if (!onRetrySync || checkingReceiptRef.current) return;
    checkingReceiptRef.current = true;
    setCheckingReceipt(true);
    try { await onRetrySync(); }
    finally {
      checkingReceiptRef.current = false;
      setCheckingReceipt(false);
    }
  };

  return (
    <div
      data-slot="ai-workspace-error-notices"
      className="ai-workspace-error-notices flex w-full min-w-0 shrink-0 flex-col gap-1.5"
    >
      <AiNoticeTransition>
        {syncError ? (
          <AiErrorNotice title={t('ai.workspace.recovery.title')}>
            <span className="flex min-w-0 flex-col gap-1">
              <span>{t((syncRecovery?.attempts ?? 0) >= 3 ? 'ai.error.streamSyncPersistent' : 'ai.error.streamSyncFailed')}</span>
              {syncRecovery && <span className="text-muted-foreground">
                {t('ai.error.streamSyncAttempts', { count: syncRecovery.attempts })}
                {syncRecovery.lastSyncedAt !== undefined && <> · {t('ai.error.streamLastSynced', {
                  time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    .format(syncRecovery.lastSyncedAt),
                })}</>}
              </span>}
              {onRetrySync && <Button type="button" variant="ghost" size="xs" className="self-start text-[11px]"
                disabled={syncRecovery?.retrying} aria-busy={syncRecovery?.retrying || undefined}
                onClick={() => { void onRetrySync(); }}>
                {t(syncRecovery?.retrying ? 'ai.error.streamSyncRetrying' : 'ai.error.streamSyncRetry')}
              </Button>}
            </span>
          </AiErrorNotice>
        ) : null}
      </AiNoticeTransition>
      <AiNoticeTransition>
        {composerState?.lastError && !composerState.failedDrafts.some(failed => failed.error.deliveryUnknown && failed.error === composerState.lastError) ? (
          <AiErrorNotice
            title={t('ai.workspace.recovery.title')}
            action={onDismissError && (
              <Button
                variant="ghost"
                size="xs"
                className="text-[11px]"
                aria-label={t('ai.workspace.recovery.dismiss')}
                onClick={onDismissError}
              >
                {t('ai.workspace.recovery.dismiss')}
              </Button>
            )}
          >
            {aiErrorMessage(composerState.lastError.message, t)}
          </AiErrorNotice>
        ) : null}
      </AiNoticeTransition>
      {composerState?.failedDrafts.map((failed, index) => {
        const confirmationOnly = Boolean(failedDraftRetryBlockedReason && failed.error.deliveryUnknown);
        const reasonId = `${blockedReasonId}-${index}`;
        return (
        <AiNoticeTransition key={failed.id}>
          <AiErrorNotice
            title={t('ai.workspace.recovery.title')}
            label={t(failed.error.deliveryUnknown ? 'ai.workspace.messageUnconfirmed' : 'ai.workspace.failedDraft')}
            action={failed.error.retryable && (confirmationOnly ? onRetrySync : onRetryFailedDraft) && <Button type="button" variant="ghost" size="xs" className="shrink-0 text-[11px]"
              disabled={composerState.phase === 'stopping' || (confirmationOnly
                ? checkingReceipt || syncRecovery?.retrying : Boolean(failedDraftRetryBlockedReason))}
              aria-busy={confirmationOnly && checkingReceipt || undefined}
              aria-describedby={failedDraftRetryBlockedReason ? reasonId : undefined}
              onClick={() => { if (confirmationOnly) void confirmReceipt(); else onRetryFailedDraft?.(failed.id); }}>
              {t(confirmationOnly
                ? checkingReceipt ? 'ai.workspace.messageConfirming' : 'ai.workspace.checkReceipt'
                : failed.error.deliveryUnknown ? 'ai.workspace.retryOriginal' : 'common.retry')}
            </Button>}
          >
            {failed.content || (failed.hasImages ? t('ai.workspace.images.attachments') : '')}
            {failed.error.retryable && failedDraftRetryBlockedReason && <span id={reasonId} className="mt-1 block text-muted-foreground">
              {failedDraftRetryBlockedReason}
            </span>}
          </AiErrorNotice>
        </AiNoticeTransition>
        );
      })}
    </div>
  );
}

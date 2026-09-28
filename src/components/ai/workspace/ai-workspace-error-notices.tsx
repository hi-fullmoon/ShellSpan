import { RefreshCwIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionError, AiSessionSyncRecovery } from '@/lib/ai/session-adapter';
import { AiErrorNotice } from './ai-error-notice';

export interface AiWorkspaceErrorNoticesProps {
  readonly composerState?: AiComposerState;
  readonly syncError?: AiSessionError;
  readonly syncRecovery?: AiSessionSyncRecovery;
  readonly onRetrySync?: () => Promise<void>;
  readonly onDismissError?: () => void;
  readonly onRetryFailedDraft?: (id: string) => void;
}

/** Workspace-level operation errors displayed below the session header. */
export function AiWorkspaceErrorNotices({
  composerState,
  syncError,
  syncRecovery,
  onRetrySync,
  onDismissError,
  onRetryFailedDraft,
}: AiWorkspaceErrorNoticesProps): React.ReactNode {
  const { t, locale } = useI18n();
  if (!syncError && !composerState?.lastError && !composerState?.failedDrafts.length) return null;

  return (
    <div
      data-slot="ai-workspace-error-notices"
      className="ai-workspace-error-notices mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] shrink-0 flex-col gap-1.5 px-[var(--ai-shell-clearance)] pt-2"
    >
      {syncError && (
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
            {onRetrySync && <Button type="button" variant="outline" size="sm" className="self-start"
              disabled={syncRecovery?.retrying} aria-busy={syncRecovery?.retrying || undefined}
              onClick={() => { void onRetrySync(); }}>
              {syncRecovery?.retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t(syncRecovery?.retrying ? 'ai.error.streamSyncRetrying' : 'ai.error.streamSyncRetry')}
            </Button>}
          </span>
        </AiErrorNotice>
      )}
      {composerState?.lastError && (
        <AiErrorNotice
          title={t('ai.workspace.recovery.title')}
          action={onDismissError && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('ai.workspace.recovery.dismiss')}
              onClick={onDismissError}
            >
              <XIcon />
            </Button>
          )}
        >
          {aiErrorMessage(composerState.lastError.message, t)}
        </AiErrorNotice>
      )}
      {composerState?.failedDrafts.map((failed) => (
        <AiErrorNotice
          key={failed.id}
          title={t('ai.workspace.recovery.title')}
          label={t('ai.workspace.failedDraft')}
          action={onRetryFailedDraft && <Button type="button" variant="outline" size="sm"
            disabled={composerState.phase === 'stopping'} onClick={() => onRetryFailedDraft(failed.id)}>
            <RefreshCwIcon data-icon="inline-start" />{t('common.retry')}
          </Button>}
        >
          {failed.content || (failed.hasImages ? t('ai.workspace.images.attachments') : '')}
        </AiErrorNotice>
      ))}
    </div>
  );
}

import { RotateCcwIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import { AiErrorNotice } from './ai-error-notice';

export interface AiWorkspaceErrorNoticesProps {
  readonly composerState?: AiComposerState;
  readonly submitting?: boolean;
  readonly onRetryFailedDraft?: (failedDraftId: string) => void;
  readonly onDismissError?: () => void;
}

/** Workspace-level operation errors displayed below the session header. */
export function AiWorkspaceErrorNotices({
  composerState,
  submitting = false,
  onRetryFailedDraft,
  onDismissError,
}: AiWorkspaceErrorNoticesProps): React.ReactNode {
  const { t } = useI18n();
  if (!composerState?.lastError && !composerState?.failedDrafts.length) return null;

  return (
    <div
      data-slot="ai-workspace-error-notices"
      className="ai-workspace-error-notices mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] shrink-0 flex-col gap-1.5 px-[var(--ai-shell-clearance)] pt-2"
    >
      {composerState.lastError && (
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
          {composerState.lastError.message}
        </AiErrorNotice>
      )}
      {composerState.failedDrafts.map((failed) => (
        <AiErrorNotice
          key={failed.id}
          title={t('ai.workspace.recovery.title')}
          label={t('ai.workspace.failedDraft')}
          action={(
            <Button
              variant="ghost"
              size="xs"
              disabled={submitting || !failed.error.retryable}
              onClick={() => onRetryFailedDraft?.(failed.id)}
            >
              <RotateCcwIcon data-icon="inline-start" />
              {t('common.retry')}
            </Button>
          )}
        >
          {failed.content}
        </AiErrorNotice>
      ))}
    </div>
  );
}

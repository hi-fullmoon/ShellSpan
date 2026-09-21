import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import { AiErrorNotice } from './ai-error-notice';

export interface AiWorkspaceErrorNoticesProps {
  readonly composerState?: AiComposerState;
  readonly onDismissError?: () => void;
}

/** Workspace-level operation errors displayed below the session header. */
export function AiWorkspaceErrorNotices({
  composerState,
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
          {aiErrorMessage(composerState.lastError.message, t)}
        </AiErrorNotice>
      )}
      {composerState.failedDrafts.map((failed) => (
        <AiErrorNotice
          key={failed.id}
          title={t('ai.workspace.recovery.title')}
          label={t('ai.workspace.failedDraft')}
        >
          {failed.content}
        </AiErrorNotice>
      ))}
    </div>
  );
}

import { createContext, useId, useRef, useState } from 'react';
import { CircleAlertIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { cn } from '@/lib/utils';
import type { AiComposerState, AiFailedDraft } from '@/lib/ai/composer-machine';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AiSessionSyncRecovery } from '@/lib/ai/session-adapter';
import { AiNoticeAction } from './ai-notice-action';

export interface AiFailedDraftRecoveryProps {
  readonly composerState?: AiComposerState;
  readonly syncRecovery?: AiSessionSyncRecovery;
  readonly onRetrySync?: () => Promise<void>;
  readonly onRetryFailedDraft?: (id: string) => void;
  readonly failedDraftRetryBlockedReason?: string | null;
}

export const AiFailedDraftRecoveryContext = createContext<AiFailedDraftRecoveryProps>({});

/** Use the submission identity, never draft text or a translated error, to locate recovery. */
export function failedDraftForMessage(
  node: AiConversationNodeOf<'userMessage'>,
  drafts: readonly AiFailedDraft[],
): AiFailedDraft | undefined {
  if (node.delivery !== 'failed' && node.delivery !== 'unconfirmed') return undefined;
  return drafts.find(draft => draft.id === (node.clientSubmissionId ?? node.messageId));
}

/** Keep failed-send recovery beside the original message. */
export function AiFailedDraftRecovery({
  failed,
  composerState,
  syncRecovery,
  onRetrySync,
  onRetryFailedDraft,
  failedDraftRetryBlockedReason = null,
}: AiFailedDraftRecoveryProps & {
  readonly failed: AiFailedDraft;
}): React.ReactNode {
  const { t } = useI18n();
  const reasonId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const checkingRef = useRef(false);
  const [checking, setChecking] = useState(false);
  const confirmationOnly = Boolean(failedDraftRetryBlockedReason && failed.error.deliveryUnknown);
  const showRetry = failed.error.retryable && Boolean(confirmationOnly ? onRetrySync : onRetryFailedDraft);
  const actionLabel = t(confirmationOnly
    ? checking ? 'ai.workspace.messageConfirming' : 'ai.workspace.checkReceipt'
    : failed.error.deliveryUnknown ? 'ai.workspace.retryOriginal' : 'common.retry');
  const confirmReceipt = async (): Promise<void> => {
    if (!onRetrySync || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try { await onRetrySync(); }
    finally { checkingRef.current = false; setChecking(false); }
  };
  return (
    <div role="alert" data-ai-failed-draft={failed.id}
      className={cn('ai-turn-error grid max-w-full min-w-0 items-center gap-x-1 rounded-lg bg-card px-2 py-0.5',
        showRetry ? 'grid-cols-[14px_minmax(0,1fr)_auto]' : 'grid-cols-[14px_minmax(0,1fr)]')}>
      <CircleAlertIcon aria-hidden="true" />
      <div className="flex min-h-6 min-w-0 items-center [overflow-wrap:anywhere]">
        {failed.error.deliveryUnknown ? <span>{t('ai.workspace.messageUnconfirmed')}</span> : <Tooltip open={detailsOpen} onOpenChange={setDetailsOpen}>
          <TooltipTrigger data-ai-failed-details=""
            aria-describedby={detailsOpen ? detailsId : undefined}
            render={<span tabIndex={0} className="cursor-help focus-visible:underline" />}>
            {t('ai.workspace.messageNotSent')}
          </TooltipTrigger>
          <TooltipContent id={detailsId} role="tooltip" className="max-h-40 max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
            {aiErrorMessage(failed.error.message, t)}
          </TooltipContent>
        </Tooltip>}
      </div>
      {showRetry && <AiNoticeAction
          data-ai-failed-retry=""
          className="shrink-0"
          disabled={composerState?.phase === 'stopping' || (confirmationOnly
            ? checking || syncRecovery?.retrying : Boolean(failedDraftRetryBlockedReason))}
          aria-busy={confirmationOnly && checking || undefined}
          aria-describedby={failedDraftRetryBlockedReason ? reasonId : undefined}
          onClick={() => { if (confirmationOnly) void confirmReceipt(); else onRetryFailedDraft?.(failed.id); }}>
          {actionLabel}
        </AiNoticeAction>}
      {failed.error.retryable && failedDraftRetryBlockedReason && <span id={reasonId} className="col-start-2 -col-end-1 text-muted-foreground [overflow-wrap:anywhere]">
        {failedDraftRetryBlockedReason}
      </span>}
    </div>
  );
}

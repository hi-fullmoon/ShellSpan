import {
  MessageCircleQuestionIcon,
  HistoryIcon,
  PanelRightCloseIcon,
  SquareTerminalIcon,
  SquarePenIcon,
} from 'lucide-react';

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import { AiHeaderIconButton } from './ai-header-icon-button';

export interface AiSessionHeaderProps {
  readonly title: string;
  readonly context: string;
  readonly status: AiSessionStatus;
  readonly mode?: 'ask' | 'agent';
  readonly onClose?: () => void;
  readonly onHistory?: () => void;
  readonly historyOpen?: boolean;
  readonly historyContent?: React.ReactNode;
  readonly onHistoryClose?: () => void;
  readonly onNewSession?: () => void;
}

export function AiSessionHeader({
  title,
  context,
  status,
  mode = 'agent',
  onClose,
  onHistory,
  historyOpen = false,
  historyContent,
  onHistoryClose,
  onNewSession,
}: AiSessionHeaderProps): React.ReactNode {
  const { t } = useI18n();
  const statusLabel = status === 'idle'
    ? t('agent.session.status.idle')
    : status === 'waiting'
      ? t('agent.session.status.waiting')
      : t(`agent.outcome.${status}`);

  return (
    <header
      data-slot="ai-workspace-header"
      data-session-status={status}
      className="ai-session-header relative flex h-10 min-h-10 min-w-0 shrink-0 items-center gap-2 px-[var(--ai-shell-clearance)]"
      data-ai-mode={mode}
    >
      <div className="ai-session-title-cluster flex min-w-0 flex-1 items-center gap-2">
        <span className="ai-session-mode-icon relative grid size-7 shrink-0 place-items-center" aria-hidden="true">
          {mode === 'ask' ? <MessageCircleQuestionIcon /> : <SquareTerminalIcon />}
          <span className="ai-session-status-dot absolute -right-0.5 -bottom-0.5 size-[7px] shrink-0" data-state={status} />
        </span>
        <span className="ai-session-heading flex min-w-0 flex-1 flex-col">
          <h2 className="ai-session-title min-w-0 truncate">{title}</h2>
          <span className="ai-session-context truncate">{context}</span>
        </span>
        <span className="sr-only">{statusLabel}</span>
      </div>

      <div className="ai-session-actions flex min-w-0 shrink-0 items-center gap-1 @min-[400px]/ai-workspace:gap-2">
        {(onHistory || historyOpen) && (
          <Popover
            open={historyOpen}
            onOpenChange={(open) => {
              if (open) onHistory?.();
              else onHistoryClose?.();
            }}
          >
            <Tooltip disabled={historyOpen}>
              <TooltipTrigger
                render={(
                  <PopoverTrigger
                    render={<AiHeaderIconButton aria-label={t('ai.history')} />}
                  />
                )}
              >
                <HistoryIcon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{t('ai.history')}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={8}
              className="ai-session-history-popover"
            >
              <PopoverTitle className="sr-only">{t('ai.workspace.sessions.title')}</PopoverTitle>
              {historyContent}
            </PopoverContent>
          </Popover>
        )}

        {onNewSession && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <AiHeaderIconButton
                  onClick={onNewSession}
                  aria-label={t('ai.newConversation')}
                />
              )}
            >
              <SquarePenIcon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('ai.newConversation')}</TooltipContent>
          </Tooltip>
        )}

        {onClose && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <AiHeaderIconButton
                  onClick={onClose}
                  aria-label={t('ai.close')}
                />
              )}
            >
              <PanelRightCloseIcon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('ai.close')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

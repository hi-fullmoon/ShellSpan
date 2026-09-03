import {
  HistoryIcon,
  PanelRightCloseIcon,
  SquarePenIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';

export interface AiSessionHeaderProps {
  readonly title: string;
  readonly context: string;
  readonly status: AiSessionStatus;
  readonly onClose?: () => void;
  readonly onHistory?: () => void;
  readonly onNewSession?: () => void;
}

export function AiSessionHeader({
  title,
  context,
  status,
  onClose,
  onHistory,
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
      className="ai-session-header"
    >
      <div className="ai-session-title-cluster">
        <span className="ai-session-status-dot" data-state={status} aria-hidden="true" />
        <span className="ai-session-heading">
          <h2 className="ai-session-title">{title}</h2>
          <span className="ai-session-context">{context}</span>
        </span>
        <span className="sr-only">{statusLabel}</span>
      </div>

      <div className="ai-session-actions">
        {onHistory && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onHistory}
                  aria-label={t('ai.history')}
                />
              )}
            >
              <HistoryIcon />
            </TooltipTrigger>
            <TooltipContent>{t('ai.history')}</TooltipContent>
          </Tooltip>
        )}

        {onNewSession && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onNewSession}
                  aria-label={t('ai.newConversation')}
                />
              )}
            >
              <SquarePenIcon />
            </TooltipTrigger>
            <TooltipContent>{t('ai.newConversation')}</TooltipContent>
          </Tooltip>
        )}

        {onClose && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  aria-label={t('ai.close')}
                />
              )}
            >
              <PanelRightCloseIcon />
            </TooltipTrigger>
            <TooltipContent>{t('ai.close')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

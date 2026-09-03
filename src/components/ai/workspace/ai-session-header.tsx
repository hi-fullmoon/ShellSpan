import {
  EllipsisIcon,
  HistoryIcon,
  PanelRightCloseIcon,
  SquarePenIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';

function statusVariant(
  status: AiSessionStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'running' || status === 'waiting') return 'secondary';
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  return 'outline';
}

export interface AiSessionHeaderProps {
  readonly title: string;
  readonly status: AiSessionStatus;
  readonly onClose?: () => void;
  readonly onHistory?: () => void;
  readonly onNewSession?: () => void;
}

export function AiSessionHeader({
  title,
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
      className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <Badge variant={statusVariant(status)} size="sm" className="shrink-0">
          {statusLabel}
        </Badge>
      </div>

      {(onHistory || onNewSession) && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={(
                <DropdownMenuTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={t('ai.workspace.sessionActions')}
                    />
                  )}
                />
              )}
            >
              <EllipsisIcon />
            </TooltipTrigger>
            <TooltipContent>{t('ai.workspace.sessionActions')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {onHistory && (
                <DropdownMenuItem onClick={onHistory}>
                  <HistoryIcon />
                  {t('ai.history')}
                </DropdownMenuItem>
              )}
              {onNewSession && (
                <DropdownMenuItem onClick={onNewSession}>
                  <SquarePenIcon />
                  {t('ai.newConversation')}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {onClose && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
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
    </header>
  );
}

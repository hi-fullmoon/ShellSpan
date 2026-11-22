import {
  ArrowLeftIcon,
  BotIcon,
  DownloadIcon,
  MessageCircleQuestionIcon,
  HistoryIcon,
  PanelRightCloseIcon,
  SquarePenIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import { AiHeaderIconButton } from './ai-header-icon-button';
import { ShellSpanGlyph } from '@/components/brand/shellspan-mark';

export interface AiSessionHeaderSubagentNav {
  readonly roleLabel: string;
  readonly subtitle: string;
  readonly subtitleTooltip: string;
  readonly backLabel?: string;
  readonly onBack?: () => void;
  readonly switcher: React.ReactNode;
  readonly hideSessionChrome?: boolean;
}

export interface AiSessionHeaderProps {
  readonly title: string;
  readonly context: string;
  readonly status: AiSessionStatus;
  readonly mode?: 'ask' | 'agent';
  readonly lineage?: React.ReactNode;
  readonly subagentNav?: AiSessionHeaderSubagentNav;
  readonly extraActions?: React.ReactNode;
  readonly onClose?: () => void;
  readonly onHistory?: () => void;
  readonly historyOpen?: boolean;
  readonly historyContent?: React.ReactNode;
  readonly onHistoryClose?: () => void;
  readonly onNewSession?: () => void;
  readonly onExportMarkdown?: () => void;
}

export function AiSessionHeader({
  title,
  context,
  status,
  mode = 'agent',
  lineage,
  subagentNav,
  extraActions,
  onClose,
  onHistory,
  historyOpen = false,
  historyContent,
  onHistoryClose,
  onNewSession,
  onExportMarkdown,
}: AiSessionHeaderProps): React.ReactNode {
  const { t } = useI18n();
  const statusLabel = status === 'idle'
    ? t('agent.session.status.idle')
    : status === 'waiting'
      ? t('agent.session.status.waiting')
      : t(`agent.outcome.${status}`);
  const showHistory = !(subagentNav?.hideSessionChrome) && (onHistory || historyOpen);
  const showNewSession = !(subagentNav?.hideSessionChrome) && Boolean(onNewSession);

  return (
    <header
      data-slot="ai-workspace-header"
      data-session-status={status}
      data-subagent-view={subagentNav ? 'true' : undefined}
      className="ai-session-header relative flex h-10 min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-app-border/50 px-[var(--ai-shell-clearance)]"
      data-ai-mode={mode}
    >
      {subagentNav ? (
        <div className="ai-session-title-cluster flex min-w-0 flex-1 items-center gap-2">
          {subagentNav.onBack && subagentNav.backLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <AiHeaderIconButton
                    onClick={subagentNav.onBack}
                    aria-label={subagentNav.backLabel}
                  />
                )}
              >
                <ArrowLeftIcon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{subagentNav.backLabel}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="ai-session-mode-icon relative grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary/10 text-primary [&>svg]:size-[15px]" aria-hidden="true">
              <BotIcon />
              <span className="ai-session-status-dot absolute -right-0.5 -bottom-0.5 size-[7px] shrink-0" data-state={status} />
            </span>
          )}
          <span className="ai-session-heading flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <h2 className="ai-session-title min-w-0 truncate text-sm font-medium leading-5 text-foreground">{title}</h2>
              <Badge variant="outline" size="sm" className="shrink-0">
                {subagentNav.roleLabel}
              </Badge>
            </span>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="ai-session-context w-fit max-w-full truncate text-[11px] leading-[15px] text-muted-foreground" />}>
                {subagentNav.subtitle}
              </TooltipTrigger>
              <TooltipContent role="tooltip" align="start" className="max-w-[min(20rem,var(--available-width))]">{subagentNav.subtitleTooltip}</TooltipContent>
            </Tooltip>
          </span>
          <span className="sr-only">{statusLabel}</span>
        </div>
      ) : (
        <div className="ai-session-title-cluster flex min-w-0 flex-1 items-center gap-2">
          <span className="ai-session-mode-icon relative grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary/10 text-primary [&>svg]:size-[15px]" aria-hidden="true">
            {mode === 'ask' ? <MessageCircleQuestionIcon /> : <ShellSpanGlyph />}
            <span className="ai-session-status-dot absolute -right-0.5 -bottom-0.5 size-[7px] shrink-0" data-state={status} />
          </span>
          <span className="ai-session-heading flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <h2 className="ai-session-title min-w-0 truncate text-sm font-medium leading-5 text-foreground">{title}</h2>
            </span>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="ai-session-context w-fit max-w-full truncate text-[11px] leading-[15px] text-muted-foreground" />}>
                {context}
              </TooltipTrigger>
              <TooltipContent role="tooltip" align="start" className="max-w-[min(20rem,var(--available-width))]">{context}</TooltipContent>
            </Tooltip>
          </span>
          <span className="sr-only">{statusLabel}</span>
        </div>
      )}

      <div className="ai-session-actions flex min-w-0 shrink-0 items-center gap-1 @min-[400px]/ai-workspace:gap-2">
        {subagentNav ? subagentNav.switcher : lineage}
        {showHistory && (
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

        {showNewSession && (
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

        {!subagentNav?.hideSessionChrome && onExportMarkdown && (
          <Tooltip>
            <TooltipTrigger
              render={(
                <AiHeaderIconButton
                  onClick={onExportMarkdown}
                  aria-label={t('ai.workspace.export.markdown')}
                />
              )}
            >
              <DownloadIcon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('ai.workspace.export.markdown')}</TooltipContent>
          </Tooltip>
        )}

        {extraActions}

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

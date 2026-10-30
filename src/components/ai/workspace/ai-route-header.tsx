import { ArrowLeftIcon, PanelRightCloseIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { AiHeaderIconButton } from './ai-header-icon-button';
import { AiContentTitle } from './ai-content-title';

export function AiRouteHeader({
  title,
  description,
  onBack,
  onClose,
  actions,
}: {
  readonly title: string;
  readonly description: string;
  readonly onBack: () => void;
  readonly onClose?: () => void;
  readonly actions?: React.ReactNode;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <header className="ai-route-header relative flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-app-border/50 px-[var(--ai-shell-clearance)] py-1" data-slot="ai-route-header">
      <Tooltip>
        <TooltipTrigger
          render={(
            <AiHeaderIconButton onClick={onBack} aria-label={t('common.back')} />
          )}
        >
          <ArrowLeftIcon data-icon="inline-start" />
        </TooltipTrigger>
        <TooltipContent>{t('common.back')}</TooltipContent>
      </Tooltip>
      <div className="ai-route-title-cluster flex min-w-0 flex-1 items-center">
        <h2 className="ai-route-title min-w-0 flex-1 text-sm font-medium leading-5 text-foreground"><AiContentTitle>{title}</AiContentTitle></h2>
        <p className="sr-only">{description}</p>
      </div>
      {(actions || onClose) && (
        <div className="ai-session-actions flex min-w-0 shrink-0 items-center gap-1 @min-[400px]/ai-workspace:gap-2">
          {actions}
          {onClose && (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <AiHeaderIconButton onClick={onClose} aria-label={t('ai.close')} />
                )}
              >
                <PanelRightCloseIcon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{t('ai.close')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </header>
  );
}

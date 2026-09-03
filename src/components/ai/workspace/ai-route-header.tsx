import { ArrowLeftIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';

export function AiRouteHeader({
  title,
  description,
  onBack,
  actions,
}: {
  readonly title: string;
  readonly description: string;
  readonly onBack: () => void;
  readonly actions?: React.ReactNode;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <header className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5">
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onBack} aria-label={t('common.back')} />
          )}
        >
          <ArrowLeftIcon />
        </TooltipTrigger>
        <TooltipContent>{t('common.back')}</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <p className="sr-only">{description}</p>
      </div>
      {actions}
    </header>
  );
}

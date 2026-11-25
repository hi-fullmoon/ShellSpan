import { SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface AiEmptyHeroQuickAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description?: string;
}

export interface AiEmptyHeroProps {
  readonly title: string;
  readonly description: string;
  readonly icon?: React.ReactNode;
  readonly quickActions?: readonly AiEmptyHeroQuickAction[];
  readonly quickActionsLabel?: string;
  readonly onSelectQuickAction?: (action: AiEmptyHeroQuickAction) => void;
}

export function AiEmptyHero({
  title,
  description,
  icon,
  quickActions,
  quickActionsLabel,
  onSelectQuickAction,
}: AiEmptyHeroProps): React.ReactNode {
  return (
    <div className="ai-empty-hero mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] flex-col items-center gap-4 px-[var(--ai-shell-clearance)] pt-0 pb-2" data-slot="ai-empty-hero">
      <EmptyState
        className="w-full gap-4 p-0 text-muted-foreground [&_[data-slot=empty-state-heading]]:min-w-0 [&_[data-slot=empty-state-heading]]:text-center [&_[data-slot=empty-state-icon]]:size-[52px] [&_[data-slot=empty-state-icon]]:rounded-[18px] [&_[data-slot=empty-state-icon]]:bg-primary/10 [&_[data-slot=empty-state-icon]]:text-primary [&_[data-slot=empty-state-icon]_svg]:size-[23px] [&_[data-slot=empty-state-title]]:min-w-0 [&_[data-slot=empty-state-title]]:text-[26px] [&_[data-slot=empty-state-title]]:leading-8 [&_[data-slot=empty-state-title]]:font-medium [&_[data-slot=empty-state-title]]:text-foreground [&_[data-slot=empty-state-description]]:max-w-[480px] [&_[data-slot=empty-state-description]]:text-[13px] [&_[data-slot=empty-state-description]]:leading-5 [&_[data-slot=empty-state-description]]:text-muted-foreground @max-[399px]/ai-workspace:[&_[data-slot=empty-state-title]]:text-[22px] @max-[399px]/ai-workspace:[&_[data-slot=empty-state-title]]:leading-7"
        title={title}
        description={description}
        icon={icon}
      />
      {quickActions && quickActions.length > 0 && onSelectQuickAction && (
        <div
          className="flex max-w-[520px] flex-wrap items-center justify-center gap-1.5"
          role="group"
          aria-label={quickActionsLabel}
          data-slot="ai-empty-hero-actions"
        >
          {quickActions.map((action) => (
            <Tooltip key={action.id}>
              <TooltipTrigger
                render={(
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 font-normal text-muted-foreground hover:text-foreground"
                    onClick={() => onSelectQuickAction(action)}
                  />
                )}
              >
                <SparklesIcon data-icon="inline-start" aria-hidden="true" />
                <span>{action.label}</span>
              </TooltipTrigger>
              <TooltipContent>
                {action.description ? `/${action.command} · ${action.description}` : `/${action.command}`}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

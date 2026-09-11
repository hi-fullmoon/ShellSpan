import { EmptyState } from '@/components/ui/empty-state';

export interface AiEmptyHeroProps {
  readonly title: string;
  readonly description: string;
  readonly icon?: React.ReactNode;
}

export function AiEmptyHero({
  title,
  description,
  icon,
}: AiEmptyHeroProps): React.ReactNode {
  return (
    <div className="ai-empty-hero mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] px-[var(--ai-shell-clearance)] pt-0 pb-2" data-slot="ai-empty-hero">
      <EmptyState
        className="w-full gap-4 p-0 [&_[data-slot=empty-state-heading]]:min-w-0 [&_[data-slot=empty-state-heading]]:text-center [&_[data-slot=empty-state-icon]]:size-[52px] [&_[data-slot=empty-state-title]]:min-w-0 [&_[data-slot=empty-state-description]]:max-w-[480px]"
        title={title}
        description={description}
        icon={icon}
      />
    </div>
  );
}

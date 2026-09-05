import { EmptyState } from '@/components/ui/empty-state';

export interface AiEmptyHeroProps {
  readonly title: string;
  readonly description: string;
}

export function AiEmptyHero({
  title,
  description,
}: AiEmptyHeroProps): React.ReactNode {
  return (
    <div className="ai-empty-hero" data-slot="ai-empty-hero">
      <EmptyState
        title={title}
        description={description}
      />
    </div>
  );
}

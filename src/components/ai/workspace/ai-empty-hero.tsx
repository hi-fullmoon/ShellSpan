import { SparklesIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

export interface AiEmptyHeroProps {
  readonly title: string;
  readonly description: string;
  readonly contextLabel?: string;
  readonly presetLabel: string;
}

export function AiEmptyHero({
  title,
  description,
  contextLabel,
  presetLabel,
}: AiEmptyHeroProps): React.ReactNode {
  return (
    <EmptyState
      className="min-w-0 px-3 pb-2 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5"
      icon={<SparklesIcon aria-hidden="true" />}
      title={title}
      description={description}
      action={(
        <div className="flex min-w-0 flex-wrap justify-center gap-1.5">
          {contextLabel && (
            <Badge variant="outline" className="max-w-full">
              <span className="truncate">{contextLabel}</span>
            </Badge>
          )}
          <Badge variant="secondary">{presetLabel}</Badge>
        </div>
      )}
    />
  );
}

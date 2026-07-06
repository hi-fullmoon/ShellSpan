import React from 'react';
import { cn } from '@/lib/utils';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  homeLabel?: string;
  className?: string;
}

export const PathBreadcrumb: React.FC<PathBreadcrumbProps> = ({
  path,
  onNavigate,
  homeLabel = '~',
  className,
}) => {
  const parts = path.split('/').filter(Boolean);

  const navigateToIndex = (index: number): void => {
    const target = '/' + parts.slice(0, index + 1).join('/');
    onNavigate(target);
  };

  return (
    <div
      className={cn(
        'flex h-7 items-center gap-1 overflow-hidden rounded-[4px] border border-app-border bg-app-surface px-2 text-xs',
        className,
      )}
    >
      <button
        onClick={() => onNavigate('')}
        className="text-app-text-soft hover:text-app-text"
      >
        {homeLabel}
      </button>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <span className="text-app-text-soft">/</span>
          <button
            onClick={() => navigateToIndex(index)}
            className="truncate hover:text-app-text"
            title={part}
          >
            {part}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

import React from 'react';
import { cn } from '@/lib/utils';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  homeLabel?: string;
  className?: string;
}

const FolderIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={cn('h-3.5 w-3.5 shrink-0 text-app-primary', className)}
  >
    <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
  </svg>
);

const ChevronIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3 w-3 shrink-0 text-app-text-soft"
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
);

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
        className="flex items-center gap-1 text-app-text-soft hover:text-app-text"
        title={homeLabel}
      >
        <FolderIcon />
        <span className="truncate max-w-[80px]">{homeLabel}</span>
      </button>

      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <ChevronIcon />
          <button
            onClick={() => navigateToIndex(index)}
            className="flex items-center gap-1 hover:text-app-text"
            title={part}
          >
            <FolderIcon />
            <span className="truncate max-w-[120px]">{part}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

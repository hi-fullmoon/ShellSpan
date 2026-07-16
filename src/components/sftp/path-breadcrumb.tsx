import React, { useState } from 'react';
import { FolderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  homeLabel?: string;
  className?: string;
}

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
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);

  const parts = path.split('/').filter(Boolean);

  const navigateToIndex = (index: number): void => {
    const target = '/' + parts.slice(0, index + 1).join('/');
    onNavigate(target);
  };

  const startEditing = (): void => {
    setEditValue(path);
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setIsEditing(false);
      onNavigate(editValue.trim());
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(path);
    }
  };

  const handleBlur = (): void => {
    setIsEditing(false);
    setEditValue(path);
  };

  return (
    <div
      className={cn(
        'flex h-7 items-center gap-1 overflow-hidden rounded-md border border-app-border bg-app-surface px-2 text-xs',
        className,
      )}
      onDoubleClick={startEditing}
    >
      {isEditing ? (
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          autoFocus
          onFocus={(e) => e.target.select()}
          className="h-5 w-full rounded-none border-0 bg-transparent px-0 py-0 text-xs shadow-none focus-visible:ring-0"
        />
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate('')}
            className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text [&_svg]:size-3"
            title={homeLabel}
          >
            <FolderIcon className="text-app-primary" />
            <span className="truncate max-w-[80px] leading-none">{homeLabel}</span>
          </Button>

          {parts.map((part, index) => (
            <React.Fragment key={index}>
              <ChevronIcon />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateToIndex(index)}
                className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text [&_svg]:size-3"
                title={part}
              >
                <FolderIcon className="text-app-primary" />
                <span className="truncate max-w-[120px] leading-none">{part}</span>
              </Button>
            </React.Fragment>
          ))}
        </>
      )}
    </div>
  );
};

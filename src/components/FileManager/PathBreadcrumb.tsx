import { type FormEvent, useMemo, useState } from 'react';
import { t } from '../../lib/i18n';
import { Input } from '@chakra-ui/react';
import { HomeIcon, CopyIcon } from '../Icons';

interface PathBreadcrumbProps {
  currentPath?: string;
  disabled?: boolean;
  onNavigate: (path: string) => void;
  onCopyPath?: () => void;
}

export function PathBreadcrumb({ currentPath, disabled, onNavigate, onCopyPath }: PathBreadcrumbProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentPath ?? '');

  const segments = useMemo(() => {
    if (!currentPath) return [];
    const normalized = currentPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts;
  }, [currentPath]);

  const handleSegmentClick = (index: number) => {
    if (!currentPath || disabled) return;
    const normalized = currentPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const target = `/${parts.slice(0, index + 1).join('/')}`;
    onNavigate(target);
  };

  const handleRootClick = () => {
    if (!disabled) onNavigate('/');
  };

  const startEdit = () => {
    if (disabled) return;
    setEditValue(currentPath ?? '');
    setEditing(true);
  };

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = editValue.trim();
    if (trimmed) onNavigate(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <form className="flex h-7 items-center gap-1" onSubmit={submitEdit}>
        <Input
          autoFocus
          className="themed-input h-7 flex-1 px-2 py-0.5 font-mono text-[12px] leading-5"
          onBlur={() => setEditing(false)}
          onChange={(e) => setEditValue(e.target.value)}
          size="xs"
          value={editValue}
        />
      </form>
    );
  }

  return (
    <div className="flex h-7 items-center gap-1 overflow-hidden rounded-[4px] border border-[var(--fm-border)] bg-[var(--fm-bg)] px-1">
      <button
        aria-label={t('fileManager.actions.root')}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-elevated)] hover:text-[var(--fm-text)] disabled:opacity-50"
        disabled={disabled}
        onClick={handleRootClick}
        type="button"
      >
        <HomeIcon />
      </button>
      {segments.map((segment, index) => (
        <div key={`${segment}-${index}`} className="flex shrink-0 items-center">
          <span className="text-[var(--fm-text-muted)]">/</span>
          <button
            className="ml-0.5 rounded-[4px] px-1 py-0.5 text-[12px] font-mono text-[var(--fm-text-soft)] hover:bg-[var(--fm-surface-elevated)] hover:text-[var(--fm-text)] disabled:opacity-50"
            disabled={disabled || index === segments.length - 1}
            onClick={() => handleSegmentClick(index)}
            onDoubleClick={index === segments.length - 1 ? startEdit : undefined}
            type="button"
          >
            {segment}
          </button>
        </div>
      ))}
      {currentPath ? (
        <button
          aria-label={t('fileManager.actions.copyCurrentDirectoryPath')}
          className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-elevated)] hover:text-[var(--fm-text)]"
          onClick={onCopyPath}
          type="button"
        >
          <CopyIcon />
        </button>
      ) : null}
    </div>
  );
}

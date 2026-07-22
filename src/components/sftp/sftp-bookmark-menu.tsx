import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

export interface SftpBookmarkMenuProps {
  open: boolean;
  x: number;
  y: number;
  bookmarks: string[];
  onNavigate: (path: string) => void;
  onClose: () => void;
}

export const SftpBookmarkMenu: React.FC<SftpBookmarkMenuProps> = ({
  open,
  x,
  y,
  bookmarks,
  onNavigate,
  onClose,
}) => {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const left = Math.min(x, window.innerWidth - 224);
  const top = Math.min(y, window.innerHeight - 280);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[1600]"
        role="presentation"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-[1700] w-56 overflow-hidden rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        {bookmarks.length === 0 ? (
          <div className="px-2.5 py-1.5 text-xs text-app-text-soft">
            {t('sftp.bookmark.empty')}
          </div>
        ) : (
          <ul className="flex flex-col gap-0">
            {bookmarks.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  onClick={() => {
                    onNavigate(path);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-app-text transition-colors hover:bg-app-primary/10 hover:text-app-primary"
                >
                  <BookmarkIcon className="h-3.5 w-3.5 shrink-0 text-app-primary" />
                  <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>,
    document.body,
  );
};

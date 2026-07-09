import React, { useRef, useState } from 'react';
import { Spinner } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useActiveController } from '@/components/Terminal/hooks/useActiveController';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';

export interface TerminalPaneProps {
  activeSession: TerminalSessionState | null;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ activeSession }) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { searchNext, searchPrevious, clearSearch } = useActiveController(
    paneRef,
    activeSession?.sessionId ?? null,
  );

  const handleCloseSearch = (): void => {
    clearSearch();
    setSearchOpen(false);
    setQuery('');
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[4px] border border-app-border bg-app-surface">
      {searchOpen && (
        <div className="flex h-9 items-center gap-2 border-b border-app-border bg-app-surface-muted px-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            className="h-6 flex-1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? searchPrevious(query) : searchNext(query);
              }
              if (e.key === 'Escape') {
                handleCloseSearch();
              }
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => searchPrevious(query)}
          >
            ↑
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => searchNext(query)}
          >
            ↓
          </Button>
          <Button variant="ghost" size="icon" onClick={handleCloseSearch}>
            ×
          </Button>
        </div>
      )}
      <div className="absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSearchOpen((prev) => !prev)}
          title="Search"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </Button>
      </div>
      {activeSession?.status === 'connecting' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface/90">
          <Spinner />
          <span className="text-xs text-app-text-soft">
            {t('terminal.status.connecting')}...
          </span>
        </div>
      )}
      <div ref={paneRef} className="h-full w-full p-2" />
    </div>
  );
};

import { useEffect, useRef, useState } from 'react';
import { Input } from '@chakra-ui/react';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';

interface TerminalSearchProps {
  terminalRef: React.RefObject<Terminal | null>;
  searchAddonRef: React.RefObject<SearchAddon | null>;
  showSearch: boolean;
  onCloseSearch: () => void;
}

export function TerminalSearch({ terminalRef, searchAddonRef, showSearch, onCloseSearch }: TerminalSearchProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  useEffect(() => {
    if (showSearch) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [showSearch]);

  const performSearch = (direction: 'next' | 'previous') => {
    const addon = searchAddonRef.current;
    if (!addon || !searchTerm) {
      return;
    }
    const options = { caseSensitive };
    if (direction === 'next') {
      addon.findNext(searchTerm, options);
    } else {
      addon.findPrevious(searchTerm, options);
    }
  };

  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations?.();
    onCloseSearch();
    setSearchTerm('');
    const terminal = terminalRef.current;
    if (terminal) {
      try {
        terminal.focus();
      } catch {
        // Terminal may have been disposed.
      }
    }
  };

  if (!showSearch) {
    return null;
  }

  return (
    <div
      className="absolute right-2 top-2 z-30 flex items-center gap-1.5 rounded-lg p-1.5 backdrop-blur-sm"
      style={{ background: 'var(--app-surface)', border: '1px solid var(--app-border)', boxShadow: 'var(--app-shadow)' }}
    >
      <Input
        ref={searchInputRef}
        className="themed-input h-7 w-44 px-2 text-xs outline-none"
        placeholder={t('terminal.search.placeholder')}
        size="xs"
        type="text"
        value={searchTerm}
        onChange={(e) => {
          setSearchTerm(e.target.value);
          if (e.target.value) {
            searchAddonRef.current?.findNext?.(e.target.value, { caseSensitive });
          } else {
            searchAddonRef.current?.clearDecorations?.();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            performSearch(e.shiftKey ? 'previous' : 'next');
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
          }
        }}
      />
      <button
        className="icon-btn h-6 w-6 px-0 text-xs"
        onClick={() => performSearch('previous')}
        title={t('terminal.search.previous')}
        type="button"
      >
        ↑
      </button>
      <button className="icon-btn h-6 w-6 px-0 text-xs" onClick={() => performSearch('next')} title={t('terminal.search.next')} type="button">
        ↓
      </button>
      <button
        className={cn('icon-btn h-6 w-6 px-0 text-xs', caseSensitive && 'bg-cyan-500/20 text-cyan-300')}
        onClick={() => {
          const next = !caseSensitive;
          setCaseSensitive(next);
          if (searchTerm) {
            searchAddonRef.current?.findNext?.(searchTerm, { caseSensitive: next });
          }
        }}
        title={t('terminal.search.caseSensitive')}
        type="button"
      >
        Aa
      </button>
      <button className="icon-btn h-6 w-6 px-0 text-xs" onClick={closeSearch} title={t('terminal.search.close')} type="button">
        ✕
      </button>
    </div>
  );
}

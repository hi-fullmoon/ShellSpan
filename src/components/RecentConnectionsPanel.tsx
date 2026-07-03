import { useMemo, useState } from 'react';
import { Input } from '@chakra-ui/react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { ScrollArea } from './ui';
import type { RecentConnection } from '../types';

interface RecentConnectionsPanelProps {
  items: RecentConnection[];
  onConnect: (item: RecentConnection) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

function ClockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="14"
      {...props}
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function RecentConnectionsPanel({ items, onConnect, onRemove, onClear }: RecentConnectionsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        (item.name?.toLowerCase().includes(query) ?? false) ||
        item.host.toLowerCase().includes(query) ||
        item.username.toLowerCase().includes(query),
    );
  }, [items, searchQuery]);

  return (
    <section className="surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="surface-header">
        <div>
          <p className="label">{t('my.menu.recentConnections')}</p>
          <h2 className="text-sm font-semibold">{t('recentConnections.title')}</h2>
        </div>
        {items.length > 0 ? (
          <button
            className="text-subtle hover:text-rose-400 text-xs transition"
            onClick={onClear}
            type="button"
          >
            {t('recentConnections.clear')}
          </button>
        ) : null}
      </div>

      <div className="px-2 py-1">
        <Input
          className="themed-input w-full text-xs outline-none transition focus:ring-1 focus:ring-cyan-400/50"
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('sidebar.searchPlaceholder')}
          size="sm"
          style={{ height: '26px', minHeight: '26px', paddingTop: '2px', paddingBottom: '2px' }}
          value={searchQuery}
        />
      </div>

      <ScrollArea className="flex-1 p-2">
        {items.length === 0 ? (
          <div className="text-subtle px-1 py-4 text-center text-xs leading-relaxed">
            {t('recentConnections.empty')}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-subtle px-1 py-4 text-center text-xs leading-relaxed">
            {t('recentConnections.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="surface-muted group flex items-center gap-2 rounded-sm px-2 py-1.5 transition hover:bg-[var(--app-surface-muted)]/80"
              >
                <ClockIcon className="shrink-0 text-[var(--app-text-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <strong className="truncate text-xs">{item.name || `${item.username}@${item.host}`}</strong>
                  </div>
                  <span className="text-subtle block truncate text-[11px]">
                    {item.username}@{item.host}:{item.port}
                  </span>
                </div>
                <span className="text-subtle shrink-0 text-[10px]">
                  {new Date(item.connectedAt).toLocaleDateString()}
                </span>
                <button
                  className={cn(
                    'icon-btn h-6 px-1.5 text-[11px] opacity-0 transition group-hover:opacity-100',
                  )}
                  onClick={() => onConnect(item)}
                  type="button"
                >
                  {t('recentConnections.connect')}
                </button>
                <button
                  className="icon-btn h-6 w-6 shrink-0 opacity-0 transition group-hover:opacity-100"
                  onClick={() => onRemove(item.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import {
  ScrollArea,
  FingerprintIcon,
  SearchIcon,
  LayoutGridIcon,
  LayoutListIcon,
  ShieldIcon,
} from './ui';
import type { KnownHostEntry } from '../types';

export function KnownHostsPanel() {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await invoke<KnownHostEntry[]>('list_known_hosts');
      setEntries(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const remove = async (host: string, port: number) => {
    if (!window.confirm(t('knownHosts.removeConfirm', { host }))) {
      return;
    }
    try {
      await invoke('remove_known_host', { host, port });
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" type="button">
            {t('knownHosts.import')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button className="icon-btn h-7 w-7" onClick={() => void load()} disabled={loading} type="button">
            <RefreshIcon />
          </button>
          <button className="icon-btn h-7 w-7" type="button">
            <SearchIcon className="h-4 w-4" />
          </button>
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'grid' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('grid')}
            type="button"
          >
            <LayoutGridIcon className="h-4 w-4" />
          </button>
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'list' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('list')}
            type="button"
          >
            <LayoutListIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        {error ? (
          <div className="rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
              <ShieldIcon className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-[var(--app-text)]">{t('knownHosts.empty.title')}</h3>
            <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">{t('knownHosts.empty.description')}</p>
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-sm font-semibold text-[var(--app-text)]">{t('knownHosts.title')}</h2>
            <div
              className={cn(
                'gap-3',
                viewMode === 'grid'
                  ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                  : 'flex flex-col',
              )}
            >
              {entries.map((entry, index) => (
                <div
                  key={`${entry.host}:${entry.port}:${index}`}
                  className="group flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3 transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-hover)]"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--app-primary-bg)] text-[var(--app-primary-text)]">
                    <FingerprintIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium text-[var(--app-text)]">
                      {entry.host}
                    </strong>
                    <span className="block truncate text-xs text-[var(--app-text-muted)]">
                      {entry.keyType}
                    </span>
                  </div>
                  <button
                    className="icon-btn h-6 px-1.5 text-[11px] text-rose-400 opacity-0 transition group-hover:opacity-100"
                    onClick={() => void remove(entry.host, entry.port)}
                    type="button"
                  >
                    {t('knownHosts.remove')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </ScrollArea>
    </section>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      <path d="M12.5 6a4.5 4.5 0 1 0 1 3" />
      <path d="M12.5 3.5V6h-2.5" />
    </svg>
  );
}

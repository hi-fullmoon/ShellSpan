import { useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { ScrollArea, ForwardingIcon, SearchIcon, LayoutGridIcon, LayoutListIcon, PlusIcon } from './ui';
import type { ConnectionProfile, PortForwardConfig } from '../types';

interface PortForwardsPanelProps {
  profiles: ConnectionProfile[];
}

interface FlattenedForward {
  id: string;
  profileName: string;
  host: string;
  port: number;
  forward: PortForwardConfig;
}

export function PortForwardsPanel({ profiles }: PortForwardsPanelProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const forwards = useMemo(() => {
    const result: FlattenedForward[] = [];
    for (const profile of profiles) {
      for (const forward of profile.portForwards ?? []) {
        result.push({
          id: `${profile.id}-${forward.kind}-${forward.localPort}-${forward.remoteHost}-${forward.remotePort}`,
          profileName: profile.name,
          host: profile.host,
          port: profile.port,
          forward,
        });
      }
    }
    return result;
  }, [profiles]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" type="button">
            <PlusIcon className="h-4 w-4" />
            {t('portForwards.newForwarding')}
          </button>
        </div>

        <div className="flex items-center gap-1">
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
        {forwards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
              <ForwardingIcon className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-[var(--app-text)]">{t('portForwards.empty.title')}</h3>
            <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">{t('portForwards.empty.description')}</p>
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-sm font-semibold text-[var(--app-text)]">{t('portForwards.title')}</h2>
            <div
              className={cn(
                'gap-3',
                viewMode === 'grid'
                  ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                  : 'flex flex-col',
              )}
            >
              {forwards.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3 transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-hover)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate text-sm font-medium text-[var(--app-text)]">{item.profileName}</strong>
                    <span className="shrink-0 text-xs text-[var(--app-text-muted)]">
                      {item.host}:{item.port}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-[var(--app-text-muted)]">{t('portForwards.localPort')}: </span>
                      <span className="font-mono text-[var(--app-text)]">{item.forward.localPort}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-[var(--app-text-muted)]">{t('portForwards.remoteHost')}: </span>
                      <span className="font-mono text-[var(--app-text)]">
                        {item.forward.remoteHost}:{item.forward.remotePort}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </ScrollArea>
    </section>
  );
}

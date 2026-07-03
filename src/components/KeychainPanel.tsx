import { useState } from 'react';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { ScrollArea, SearchIcon, LayoutGridIcon, LayoutListIcon, PlusIcon } from './ui';
import { KeyTypeEcdsaIcon, KeyTypeRsaIcon } from './ui/Icons';

interface KeyItem {
  id: string;
  name: string;
  type: 'ECDSA' | 'RSA';
}

const MOCK_KEYS: KeyItem[] = [
  { id: '40c8b46c-716b-42c5-830b-2752c335fa58', name: '40c8b46c-716b-42c5-830b-2752c335fa58', type: 'ECDSA' },
  { id: '116.62.163.202', name: '116.62.163.202', type: 'RSA' },
];

const TOOLBAR_LINKS = [
  { key: 'certificate', label: t('keychain.toolbar.certificate') },
  { key: 'touchId', label: t('keychain.toolbar.touchId') },
  { key: 'fido2', label: t('keychain.toolbar.fido2') },
];

function KeyIcon({ type }: { type: KeyItem['type'] }) {
  const Icon = type === 'ECDSA' ? KeyTypeEcdsaIcon : KeyTypeRsaIcon;
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--app-primary-bg)] text-[var(--app-primary-text)]">
      <Icon className="h-5 w-5" />
    </div>
  );
}

export function KeychainPanel() {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" type="button">
            <PlusIcon className="h-4 w-4" />
            {t('keychain.newKey')}
          </button>
          <div className="h-4 w-px bg-[var(--app-border)]" />
          {TOOLBAR_LINKS.map((link) => (
            <button
              key={link.key}
              className="btn-ghost text-[var(--app-text-soft)]"
              type="button"
            >
              {link.label}
            </button>
          ))}
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
        <h2 className="mb-3 text-sm font-semibold text-[var(--app-text)]">{t('keychain.title')}</h2>

        {MOCK_KEYS.length === 0 ? (
          <EmptyKeychainState />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {MOCK_KEYS.map((key) => (
              <button
                key={key.id}
                className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3 text-left transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-hover)]"
                type="button"
              >
                <KeyIcon type={key.type} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--app-text)]">{key.name}</div>
                  <div className="text-xs text-[var(--app-text-muted)]">
                    {t('keychain.type', { type: key.type })}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function EmptyKeychainState() {
  return (
    <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
      <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
        <KeyTypeEcdsaIcon className="h-7 w-7" />
      </div>
      <h3 className="text-base font-semibold text-[var(--app-text)]">{t('keychain.empty.title')}</h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">{t('keychain.empty.description')}</p>
    </div>
  );
}

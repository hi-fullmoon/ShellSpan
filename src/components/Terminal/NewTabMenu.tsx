import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import type { ConnectionProfile } from '@/types';

export interface NewTabMenuProps {
  open: boolean;
  onClose: () => void;
}

const ServerIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);

const PlusIcon: React.FC = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const NewTabMenu: React.FC<NewTabMenuProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const { connect } = useConnectSession();
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  const [query, setQuery] = useState('');

  const filteredProfiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(q) ||
        profile.host.toLowerCase().includes(q) ||
        profile.username.toLowerCase().includes(q),
    );
  }, [profiles, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const handleOpenWorkbench = (): void => {
    setActiveSection('workbench');
    onClose();
  };

  const handleConnect = (profile: ConnectionProfile): void => {
    void connect(profile);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div
        className="absolute inset-0 bg-black/30"
        role="presentation"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-2xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-[var(--shadow-dialog)]">
        <div className="max-h-[80vh] overflow-y-auto p-5">
          <div className="relative mb-5">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('terminal.newTabMenu.searchPlaceholder')}
              className="h-11 pr-16 text-sm"
              autoFocus
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-app-border bg-app-surface-muted px-1.5 py-0.5 text-xs text-app-text-soft">
              ⌘K
            </span>
          </div>

          <section className="mb-5">
            <h3 className="mb-2 text-sm font-semibold text-app-text">
              {t('terminal.newTabMenu.workspaceTemplates')}
            </h3>
            <button
              type="button"
              onClick={handleOpenWorkbench}
              className="flex w-full items-center gap-3 rounded-xl border border-app-border bg-app-surface-muted/40 p-3 text-left transition-colors hover:bg-app-surface-muted"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-primary text-app-primary-text">
                <PlusIcon />
              </div>
              <span className="flex-1 text-sm font-medium text-app-text">
                {t('terminal.newTabMenu.newConnectionTemplate')}
              </span>
              <span className="text-xs text-app-text-soft">
                {t('terminal.newTabMenu.connectionCount', {
                  count: profiles.length,
                })}
              </span>
            </button>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-app-text">
                {t('terminal.newTabMenu.recentConnections')}
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleOpenWorkbench}
                >
                  {t('terminal.newTabMenu.newConnection')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleOpenWorkbench}
                >
                  {t('terminal.newTabMenu.openWorkbench')}
                </Button>
              </div>
            </div>

            {filteredProfiles.length === 0 ? (
              <div className="rounded-xl border border-dashed border-app-border p-6 text-center">
                <p className="text-xs text-app-text-soft">
                  {query
                    ? t('terminal.newTabMenu.noSearchResults')
                    : t('terminal.tab.noProfiles')}
                </p>
                {!query && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenWorkbench}
                    className="mt-2"
                  >
                    {t('section.workbench')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {filteredProfiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      onClick={() => handleConnect(profile)}
                      className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors hover:bg-app-surface-muted even:bg-app-surface-muted/30"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary">
                        <ServerIcon />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-app-text">
                          {profile.name}
                        </p>
                        <p className="truncate text-xs text-app-text-soft">
                          {profile.username}@{profile.host}:{profile.port}
                        </p>
                      </div>
                      <span className="text-xs text-app-text-soft">
                        {t('terminal.newTabMenu.personal')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

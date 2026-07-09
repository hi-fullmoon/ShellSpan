import React, { useEffect } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { Button } from '@/components/ui/Button';

export interface NewTabMenuProps {
  open: boolean;
  onClose: () => void;
}

export const NewTabMenu: React.FC<NewTabMenuProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const { connect } = useConnectSession();
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  useEffect(() => {
    if (!open) return;
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

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        role="presentation"
        onClick={onClose}
      />
      <div className="absolute right-2 top-9 z-50 w-64 overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-[var(--shadow-dialog)]">
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-4">
            <p className="text-xs text-app-text-soft">
              {t('terminal.tab.noProfiles')}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActiveSection('workbench');
                onClose();
              }}
            >
              {t('section.workbench')}
            </Button>
          </div>
        ) : (
          <ul className="py-1">
            {profiles.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  onClick={() => {
                    void connect(profile);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-app-surface-muted"
                >
                  <span className="flex-1 truncate text-app-text">
                    {profile.name}
                  </span>
                  <span className="text-app-text-soft">
                    {profile.username}@{profile.host}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

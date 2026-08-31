import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog } from '@/components/ui/dialog';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { useI18n } from '@/hooks/useI18n';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { isTauriRuntime } from '@/lib/tauri';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

const GITHUB_URL = 'https://github.com/hi-fullmoon/ShellSpan';

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!open || !isTauriRuntime()) {
      setVersion('');
      return;
    }

    const load = async (): Promise<void> => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const v = await getVersion();
        setVersion(v);
      } catch {
        setVersion('');
      }
    };

    void load();
  }, [open]);

  const openGitHub = useCallback((): void => {
    if (isTauriRuntime()) {
      void invoke('open_url', { url: GITHUB_URL });
    } else {
      window.open(GITHUB_URL, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleOpenGitHub = useDebouncedCallback(openGitHub, 500);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <CompactDialogContent className="max-w-md">
        <CompactDialogHeader
          title={t('about.title')}
          description={t('app.tagline')}
        />
        <CompactDialogBody>
          <div
            data-slot="about-content"
            className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-muted/30 px-3 py-2.5 text-sm"
          >
            <div data-slot="about-version-row" className="flex justify-between gap-4">
              <span className="shrink-0 text-app-text-soft">{t('about.version')}</span>
              <span className="text-app-text">{version || '--'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-app-text-soft">{t('about.author')}</span>
              <span className="text-app-text">hi-fullmoon</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-app-text-soft">{t('about.license')}</span>
              <span className="text-app-text">MIT</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="shrink-0 text-app-text-soft">{t('about.source')}</span>
              <button
                className="min-w-0 truncate text-left text-primary hover:underline"
                onClick={handleOpenGitHub}
                type="button"
              >
                {GITHUB_URL}
              </button>
            </div>
          </div>
        </CompactDialogBody>
      </CompactDialogContent>
    </Dialog>
  );
};

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { isTauriRuntime } from '@/lib/tauri';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

const GITHUB_URL = 'https://github.com/hi-fullmoon/TermBridge';

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

  const handleOpenGitHub = (): void => {
    if (isTauriRuntime()) {
      void invoke('open_url', { url: GITHUB_URL });
    } else {
      window.open(GITHUB_URL, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-sm bg-app-surface border-app-border">
        <DialogHeader>
          <DialogTitle>{t('about.title')}</DialogTitle>
          <DialogDescription>{t('app.tagline')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2 text-sm">
          {version ? (
            <div className="flex justify-between">
              <span className="text-app-text-soft">{t('about.version')}</span>
              <span className="text-app-text">{version}</span>
            </div>
          ) : null}
          <div className="flex justify-between">
            <span className="text-app-text-soft">{t('about.author')}</span>
            <span className="text-app-text">hi-fullmoon</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text-soft">{t('about.license')}</span>
            <span className="text-app-text">MIT</span>
          </div>
          <div className="flex justify-between items-center gap-4">
            <span className="text-app-text-soft shrink-0">{t('about.source')}</span>
            <button
              className="truncate text-left text-primary hover:underline"
              onClick={handleOpenGitHub}
              type="button"
            >
              {GITHUB_URL}
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t('about.ok')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

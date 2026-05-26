import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './Dialog';
import { t } from '../lib/i18n';
import { isTauriRuntime } from '../lib/tauri';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

const GITHUB_URL = 'https://github.com/hi-fullmoon/TermBridge';

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!open || !isTauriRuntime()) {
      return;
    }

    const load = async () => {
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

  const handleOpenGitHub = () => {
    if (isTauriRuntime()) {
      void invoke('open_url', { url: GITHUB_URL });
    } else {
      window.open(GITHUB_URL, '_blank');
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-sm p-3" ariaLabel={t('app.aboutDialog.ariaLabel')}>
        <DialogHeader
          description={t('app.aboutDialog.description')}
          kicker={t('app.aboutDialog.kicker')}
          title={t('app.aboutDialog.title')}
        />
        <div className="flex flex-col gap-2 py-1 text-xs text-(--app-text-soft)">
          {version ? (
            <div className="flex justify-between">
              <span>{t('app.aboutDialog.version')}</span>
              <span className="text-(--app-text)">{version}</span>
            </div>
          ) : null}
          <div className="flex justify-between">
            <span>{t('app.aboutDialog.author')}</span>
            <span className="text-(--app-text)">hi-fullmoon</span>
          </div>
          <div className="flex justify-between">
            <span>{t('app.aboutDialog.license')}</span>
            <span className="text-(--app-text)">MIT</span>
          </div>
          <div className="flex justify-between items-center">
            <span>{t('app.aboutDialog.source')}</span>
            <button
              className="text-left text-(--app-accent) hover:underline"
              onClick={handleOpenGitHub}
              type="button"
            >
              {GITHUB_URL}
            </button>
          </div>
        </div>
        <DialogFooter>
          <button className="btn-primary" onClick={onClose} type="button">
            {t('app.common.ok')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}

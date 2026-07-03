import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import { ScrollArea, ClockIcon } from './ui';
import type { LogFileInfo } from '../types';

export function LogsPanel() {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [activeFile, setActiveFile] = useState<string | undefined>();
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setFiles([]);
    setActiveFile(undefined);
    setContent('');
    setError(undefined);
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <ScrollArea className="flex-1 p-4">
        <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
          <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
            <ClockIcon className="h-7 w-7" />
          </div>
          <h3 className="text-base font-semibold text-[var(--app-text)]">{t('logs.upgrade.title')}</h3>
          <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">
            <a className="text-[var(--app-primary-bg)] hover:underline" href="#">
              {t('logs.upgrade.action')}
            </a>{' '}
            {t('logs.upgrade.description')}
          </p>
        </div>
      </ScrollArea>
    </section>
  );
}

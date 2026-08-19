import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useUpdateStore } from '@/stores/updateStore';
import { isTauriRuntime } from '@/lib/tauri';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const UpdateSection: React.FC = () => {
  const { t } = useI18n();
  const phase = useUpdateStore((state) => state.phase);
  const version = useUpdateStore((state) => state.version);
  const downloadProgress = useUpdateStore((state) => state.downloadProgress);
  const downloadIndeterminate = useUpdateStore((state) => state.downloadIndeterminate);
  const error = useUpdateStore((state) => state.error);
  const runCheck = useUpdateStore((state) => state.runCheck);
  const installNow = useUpdateStore((state) => state.installNow);

  const [currentVersion, setCurrentVersion] = useState('');

  useEffect(() => {
    if (!isTauriRuntime()) {
      setCurrentVersion('');
      return;
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const resolved = await getVersion();
        if (!cancelled) setCurrentVersion(resolved);
      } catch {
        if (!cancelled) setCurrentVersion('');
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const checking = phase === 'checking';
  const downloading = phase === 'downloading';
  const downloaded = phase === 'downloaded';
  const failed = phase === 'error';
  const targetVersion = version.downloadedVersion ?? version.latestVersion;
  const displayProgress = Math.max(0, Math.min(100, downloadProgress ?? 0));

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm font-medium text-foreground">
            {t('settings.general.update')}
          </Label>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t('settings.general.currentVersion', { version: currentVersion || '--' })}
          </p>
        </div>
        {!downloading && !downloaded && (
          <Button size="sm" disabled={checking} onClick={() => void runCheck('manual')}>
            {checking ? t('settings.general.checkingUpdate') : t('settings.general.checkUpdate')}
          </Button>
        )}
      </div>

      {checking && (
        <p className="text-xs text-muted-foreground">{t('update.checking')}</p>
      )}

      {downloading && (
        <div className="flex flex-col gap-1.5">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-app-border/60"
            data-slot="update-progress-track"
          >
            <div
              data-slot="update-progress-bar"
              className={cn(
                'h-full rounded-full bg-primary transition-all duration-200',
                downloadIndeterminate && 'w-1/2 animate-pulse',
              )}
              style={downloadIndeterminate ? undefined : { width: `${displayProgress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {downloadIndeterminate
              ? t('update.downloading')
              : t('update.progress', { progress: displayProgress })}
          </p>
        </div>
      )}

      {downloaded && (
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-xs text-muted-foreground">
            {targetVersion
              ? t('update.restartDialog.description', { version: targetVersion })
              : t('update.downloaded')}
          </p>
          <Button size="sm" onClick={() => void installNow()}>
            {t('update.restartDialog.installNow')}
          </Button>
        </div>
      )}

      {failed && (
        <div className="flex items-center justify-between gap-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="min-w-0 flex-1 truncate text-xs text-destructive" />
              }
            >
              {error ?? t('update.failed', { error: '' })}
            </TooltipTrigger>
            <TooltipContent className="break-all">{error ?? t('update.failed', { error: '' })}</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={() => void runCheck('manual')}>
            {t('settings.general.retry')}
          </Button>
        </div>
      )}

      {phase === 'no_update' && (
        <p className="text-xs text-muted-foreground">{t('update.latest')}</p>
      )}
    </div>
  );
};

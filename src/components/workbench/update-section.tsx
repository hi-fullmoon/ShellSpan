import React, { useEffect, useState } from 'react';
import { DownloadIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useUpdateStore } from '@/stores/updateStore';
import { isTauriRuntime } from '@/lib/tauri';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
    <Field className="min-h-20 gap-3 px-5 py-4 @min-[34rem]:flex-row @min-[34rem]:items-center @min-[34rem]:justify-between @min-[34rem]:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <FieldLabel className="text-sm font-medium text-foreground">
          {t('settings.general.update')}
        </FieldLabel>
        <FieldDescription className="leading-5">
          {t('settings.general.currentVersion', { version: currentVersion || '--' })}
        </FieldDescription>
      </div>

      <div className="flex min-h-8 w-full flex-col items-stretch justify-center gap-2 @min-[34rem]:w-auto @min-[34rem]:min-w-44 @min-[34rem]:shrink-0 @min-[34rem]:items-end">
        {!downloading && !downloaded && (
          <Button size="sm" disabled={checking} onClick={() => void runCheck('manual')}>
            <RefreshCwIcon data-icon="inline-start" className={cn(checking && 'animate-spin')} />
            {checking ? t('settings.general.checkingUpdate') : t('settings.general.checkUpdate')}
          </Button>
        )}

        {checking && <p className="text-xs text-muted-foreground">{t('update.checking')}</p>}

        {downloading && (
          <div className="flex w-full flex-col gap-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-border/60" data-slot="update-progress-track">
              <div
                data-slot="update-progress-bar"
                className={cn('h-full rounded-full bg-primary transition-all duration-200', downloadIndeterminate && 'w-1/2 animate-pulse')}
                style={downloadIndeterminate ? undefined : { width: `${displayProgress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {downloadIndeterminate ? t('update.downloading') : t('update.progress', { progress: displayProgress })}
            </p>
          </div>
        )}

        {downloaded && (
          <div className="flex items-center justify-between gap-4">
            <p className="min-w-0 text-xs text-muted-foreground">
              {targetVersion ? t('update.restartDialog.description', { version: targetVersion }) : t('update.downloaded')}
            </p>
            <Button size="sm" onClick={() => void installNow()}>
              <DownloadIcon data-icon="inline-start" />
              {t('update.restartDialog.installNow')}
            </Button>
          </div>
        )}

        {failed && (
          <div className="flex items-center justify-between gap-3">
            <Tooltip>
              <TooltipTrigger render={<p className="min-w-0 flex-1 truncate text-xs text-destructive" />}>
                {error ?? t('update.failed', { error: '' })}
              </TooltipTrigger>
              <TooltipContent className="break-all">{error ?? t('update.failed', { error: '' })}</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={() => void runCheck('manual')}>
              <RotateCcwIcon data-icon="inline-start" />
              {t('settings.general.retry')}
            </Button>
          </div>
        )}

        {phase === 'no_update' && <p className="text-xs text-muted-foreground">{t('update.latest')}</p>}
      </div>
    </Field>
  );
};

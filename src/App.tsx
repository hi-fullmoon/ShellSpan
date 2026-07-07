import React, { Suspense } from 'react';
import { cn } from '@/lib/utils';
import { AppShell, MainContent } from '@/components/layout/AppShell';
import { useAppStore } from '@/stores/appStore';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { Spinner } from '@/components/ui/EmptyState';

const Workbench = React.lazy(() => import('@/components/Workbench'));
const Terminal = React.lazy(() => import('@/components/Terminal'));
const Sftp = React.lazy(() => import('@/components/Sftp'));

import { useTransferListeners } from '@/hooks/useTransferListeners';
import { openSettingsWindow } from '@/lib/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

export const App: React.FC = () => {
  useTheme();
  useTransferListeners();
  React.useEffect(() => {
    const listeners: Promise<() => void>[] = [];

    const setup = async (): Promise<void> => {
      listeners.push(
        listen('system-open-settings', () => {
          openSettingsWindow().catch(() => {
            // ignore
          });
        }),
      );
      listeners.push(
        listen('system-check-update', () => {
          // eslint-disable-next-line no-alert
          alert('Checking for updates...');
        }),
      );
      listeners.push(
        listen('system-about', () => {
          // eslint-disable-next-line no-alert
          alert('TermBridge\n\nA clean and elegant SSH workbench.');
        }),
      );
      listeners.push(
        listen('system-request-app-exit', () => {
          invoke('request_app_exit').catch(() => {
            // ignore
          });
        }),
      );
    };

    setup();

    return () => {
      Promise.all(listeners).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
    };
  }, []);
  const { ready } = useI18n();
  const activeSection = useAppStore((state) => state.activeSection);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-app-bg">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <AppShell>
      <MainContent>
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center">
              <Spinner size={24} />
            </div>
          }
        >
          <div
            className={cn(
              'h-full',
              activeSection !== 'workbench' && 'hidden',
            )}
          >
            <Workbench />
          </div>
          <div
            className={cn(
              'h-full',
              activeSection !== 'terminal' && 'hidden',
            )}
          >
            <Terminal />
          </div>
          <div
            className={cn(
              'h-full',
              activeSection !== 'sftp' && 'hidden',
            )}
          >
            <Sftp />
          </div>
        </Suspense>
      </MainContent>
    </AppShell>
  );
};

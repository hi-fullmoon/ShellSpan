import React from 'react';
import { AlertTriangleIcon, CloudUploadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentNotificationReceipt } from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import { createLogger } from '@/lib/logger';
import {
  invokeShowDeploymentNotification,
  listenToDeploymentNotificationOpen,
} from '@/lib/ipc/tauri';
import { useAppStore } from '@/stores/appStore';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useToastStore } from '@/stores/toastStore';

const logger = createLogger('deployment-experience');

function notificationCopy(
  receipt: DeploymentNotificationReceipt,
  t: ReturnType<typeof useI18n>['t'],
): { title: string; body: string; variant: 'info' | 'success' | 'error' } {
  return {
    title: t(`deployment.notification.${receipt.kind}.title` as LocaleKey),
    body: t(`deployment.notification.${receipt.kind}.body` as LocaleKey, {
      workflow: receipt.workflowName,
      run: receipt.runId,
    }),
    variant: receipt.kind === 'succeeded'
      ? 'success'
      : receipt.kind === 'userActionRequired'
        ? 'info'
        : 'error',
  };
}

export const DeploymentExperience: React.FC = () => {
  const { t } = useI18n();
  const initialized = useDeploymentStore((state) => state.initialized);
  const loading = useDeploymentStore((state) => state.loading);
  const candidates = useDeploymentStore((state) => state.recoveryCandidates);
  const receipts = useDeploymentStore((state) => state.notificationReceipts);
  const activeSection = useAppStore((state) => state.activeSection);
  const activeWorkbenchTab = useAppStore((state) => state.activeWorkbenchTab);
  const shownRef = React.useRef(new Set<string>());
  const startupClaimedRef = React.useRef(false);

  const openRun = React.useCallback((runId: string): void => {
    useDeploymentStore.getState().setProfileFilter(null);
    const app = useAppStore.getState();
    app.setActiveSection('workbench');
    app.setActiveWorkbenchTab('deployments');
    void useDeploymentStore.getState().selectRun(runId).catch(() => undefined);
  }, []);

  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenToDeploymentNotificationOpen((event) => openRun(event.payload))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => logger.warn('Failed to listen for deployment notification clicks', error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openRun]);

  React.useEffect(() => {
    if (initialized || loading) return;
    void useDeploymentStore.getState().loadWorkflows()
      .catch((error) => logger.warn('Failed to initialize deployment experience', error));
  }, [initialized, loading]);

  React.useEffect(() => {
    if (!initialized || startupClaimedRef.current) return;
    startupClaimedRef.current = true;
    void useDeploymentStore.getState().claimNotifications()
      .catch((error) => logger.warn('Failed to claim deployment notifications', error));
  }, [initialized]);

  React.useEffect(() => {
    for (const receipt of receipts) {
      const key = `${receipt.runId}:${receipt.eventSequence}:${receipt.kind}`;
      if (shownRef.current.has(key)) continue;
      shownRef.current.add(key);
      const copy = notificationCopy(receipt, t);
      useToastStore.getState().addToast(copy.body, copy.variant, 12_000, {
        label: t('deployment.notification.open'),
        onClick: () => openRun(receipt.runId),
      });

      void invokeShowDeploymentNotification({
        runId: receipt.runId,
        title: copy.title,
        body: t('deployment.notification.systemBody', { run: receipt.runId }),
        openLabel: t('deployment.notification.open'),
      }).catch((error) => logger.warn('Failed to display deployment notification', error));
    }
  }, [openRun, receipts, t]);

  const outsideDeploymentCenter = activeSection !== 'workbench'
    || activeWorkbenchTab !== 'deployments';
  const firstCandidate = candidates[0];
  if (!outsideDeploymentCenter || !firstCandidate) return null;

  return (
    <aside
      aria-label={t('deployment.recovery.globalLabel')}
      className="pointer-events-auto absolute right-4 bottom-4 z-40 flex max-w-sm items-center gap-3 rounded-xl border border-app-warning/30 bg-popover/95 p-3 shadow-lg backdrop-blur"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-app-warning/10 text-app-warning">
        <AlertTriangleIcon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{t('deployment.recovery.globalTitle')}</span>
        <span className="block text-xs text-muted-foreground">
          {t('deployment.recovery.globalDescription', { count: candidates.length })}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => openRun(firstCandidate.runId)}>
        <CloudUploadIcon data-icon="inline-start" />
        {t('deployment.recovery.open')}
      </Button>
    </aside>
  );
};

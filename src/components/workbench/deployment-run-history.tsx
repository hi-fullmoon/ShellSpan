import React, { useState } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  DownloadIcon,
  HistoryIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  XIcon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentRunEvent, DeploymentRunRecord } from '@/lib/deployment/types';
import { invokeExportDeploymentRunAudit } from '@/lib/ipc/tauri';
import type { LocaleKey } from '@/locales';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';

interface DeploymentRunHistoryProps {
  display?: 'card' | 'dialog';
  onClose?: () => void;
  onNavigateToWorkspace?: () => void;
}

function formatMoment(value: number | null, locale: string): string {
  if (value == null) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(value);
}

function formatDuration(run: DeploymentRunRecord): string {
  const end = run.finishedAt ?? (run.startedAt ? Date.now() : null);
  if (run.startedAt == null || end == null) return '—';
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function statusVariant(status: DeploymentRunRecord['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'state_unknown') return 'destructive';
  if (status === 'in_progress' || status === 'verifying' || status === 'reconciling') return 'secondary';
  return 'outline';
}

function evidenceSummary(event: DeploymentRunEvent): string | null {
  const payload = event.payload;
  if (!payload) return null;
  const parts: string[] = [];
  for (const key of ['phase', 'action', 'outcome', 'failureCategory'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length <= 160) parts.push(`${key}: ${value}`);
  }
  const remoteSequence = payload.remoteSequence;
  if (typeof remoteSequence === 'number') parts.push(`remoteSequence: ${remoteSequence}`);
  const reconciliationRequired = payload.reconciliationRequired;
  if (typeof reconciliationRequired === 'boolean') {
    parts.push(`reconciliationRequired: ${reconciliationRequired}`);
  }
  const result = payload.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Readonly<Record<string, unknown>>;
    if (typeof record.outcome === 'string') parts.push(`outcome: ${record.outcome}`);
    const nestedEvidence = record.evidence;
    if (nestedEvidence && typeof nestedEvidence === 'object' && !Array.isArray(nestedEvidence)) {
      const evidence = nestedEvidence as Readonly<Record<string, unknown>>;
      for (const key of ['remoteSequence', 'currentReleaseId', 'previousReleaseId'] as const) {
        const value = evidence[key];
        if ((typeof value === 'string' && value.length <= 160) || typeof value === 'number') {
          parts.push(`${key}: ${value}`);
        }
      }
      for (const key of [
        'targetReleaseVerified',
        'rollbackReleaseVerified',
        'composeServicesVerified',
        'healthVerified',
        'approvalReusable',
      ] as const) {
        const value = evidence[key];
        if (typeof value === 'boolean') parts.push(`${key}: ${value}`);
      }
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export const DeploymentRunHistory: React.FC<DeploymentRunHistoryProps> = ({
  display = 'card',
  onClose,
  onNavigateToWorkspace,
}) => {
  const { t, locale } = useI18n();
  const workflows = useDeploymentStore((state) => state.workflows);
  const runs = useDeploymentStore((state) => state.runs);
  const runsLoading = useDeploymentStore((state) => state.runsLoading);
  const runsLoadingMore = useDeploymentStore((state) => state.runsLoadingMore);
  const runsError = useDeploymentStore((state) => state.runsError);
  const runsNextCursor = useDeploymentStore((state) => state.runsNextCursor);
  const selectedRunId = useDeploymentStore((state) => state.selectedRunId);
  const runDetail = useDeploymentStore((state) => state.runDetail);
  const runDetailLoading = useDeploymentStore((state) => state.runDetailLoading);
  const recoveredBinding = useDeploymentStore((state) => state.recoveredApprovedBinding);
  const activePlan = useDeploymentStore((state) => state.plan);
  const profiles = useProfileStore((state) => state.profiles);
  const loadRunHistory = useDeploymentStore((state) => state.loadRunHistory);
  const selectRun = useDeploymentStore((state) => state.selectRun);
  const loadEarlierRunEvents = useDeploymentStore((state) => state.loadEarlierRunEvents);
  const prepareNewPlan = useDeploymentStore((state) => state.prepareNewPlan);
  const addToast = useToastStore((state) => state.addToast);
  const [exporting, setExporting] = useState(false);
  const runsErrorToastRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!runsError) {
      runsErrorToastRef.current = null;
      return;
    }
    if (runsErrorToastRef.current === runsError) return;
    runsErrorToastRef.current = runsError;
    addToast(`${t('deployment.history.loadFailed')}\n${runsError}`, 'error', 6_000);
    useDeploymentStore.setState({ runsError: null });
  }, [addToast, runsError, t]);

  const run = runDetail?.run ?? runs.find((candidate) => candidate.id === selectedRunId) ?? null;
  const workflow = run
    ? workflows.find((candidate) => candidate.id === run.workflowId) ?? null
    : null;
  const profile = run
    ? profiles.find((candidate) => candidate.id === run.approvalSummary.frozen.target.profileId)
    : undefined;
  const expired = Boolean(run && Date.now() >= run.approvalSummary.expiresAt);
  const inputsChanged = Boolean(run && (
    !workflow
    || workflow.revision !== run.workflowRevision
    || !profile
    || profile.updatedAt !== run.approvalSummary.frozen.target.profileUpdatedAt
  ));
  const canResumeApproval = Boolean(
    run?.status === 'approved'
    && !expired
    && !inputsChanged
    && recoveredBinding?.planId === `plan-${run.approvalDigest}`
    && activePlan?.runId === run.id,
  );

  const focusRecovery = (): void => {
    void selectRun(null);
    onNavigateToWorkspace?.();
    window.requestAnimationFrame(() => {
      document.getElementById('deployment-recovery-card')?.focus();
    });
  };

  const startNewPlan = (): void => {
    if (!run) return;
    prepareNewPlan(run.workflowId);
    onNavigateToWorkspace?.();
    window.requestAnimationFrame(() => {
      document.getElementById('deployment-release-workflow')?.focus();
    });
  };

  const continueApproved = (): void => {
    void selectRun(null);
    onNavigateToWorkspace?.();
    window.requestAnimationFrame(() => {
      document.getElementById('deployment-release-workflow')?.focus();
    });
  };

  const exportAudit = async (): Promise<void> => {
    if (!run || exporting) return;
    setExporting(true);
    try {
      const result = await invokeExportDeploymentRunAudit(run.id);
      if (result.saved) addToast(t('deployment.history.auditExported'), 'success');
    } catch {
      addToast(t('deployment.history.auditExportFailed'), 'error');
    } finally {
      setExporting(false);
    }
  };

  const renderNextStep = (): React.ReactNode => {
    if (!run) return null;
    if (run.status === 'state_unknown' || run.reconciliationRequired) {
      return (
        <Alert variant="destructiveSubtle">
          <ShieldAlertIcon />
          <AlertTitle>{t('deployment.history.next.reconcile')}</AlertTitle>
          <AlertDescription>{t('deployment.history.next.reconcileDescription')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={focusRecovery}>{t('deployment.recovery.open')}</Button></AlertAction>
        </Alert>
      );
    }
    if (expired || inputsChanged) {
      return (
        <Alert variant="warning">
          <Clock3Icon />
          <AlertTitle>{t('deployment.history.next.newPlan')}</AlertTitle>
          <AlertDescription>{t(expired
            ? 'deployment.history.next.expiredDescription'
            : 'deployment.history.next.changedDescription')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={startNewPlan}>{t('deployment.history.createNewPlan')}</Button></AlertAction>
        </Alert>
      );
    }
    if (canResumeApproval) {
      return (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>{t('deployment.history.next.approvedReusable')}</AlertTitle>
          <AlertDescription>{t('deployment.history.next.approvedReusableDescription')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={continueApproved}>{t('deployment.history.continueApproved')}</Button></AlertAction>
        </Alert>
      );
    }
    if (run.status === 'approved') {
      return (
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>{t('deployment.history.next.approvedNeedsCheck')}</AlertTitle>
          <AlertDescription>{t('deployment.history.next.approvedNeedsCheckDescription')}</AlertDescription>
        </Alert>
      );
    }
    if (run.status === 'failed' || run.status === 'canceled') {
      return (
        <Alert variant="warning">
          <RotateCcwIcon />
          <AlertTitle>{t('deployment.history.next.newPlan')}</AlertTitle>
          <AlertDescription>{t('deployment.history.next.failedDescription')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={startNewPlan}>{t('deployment.history.createNewPlan')}</Button></AlertAction>
        </Alert>
      );
    }
    if (['in_progress', 'verifying', 'cancel_requested', 'reconciling'].includes(run.status)) {
      return (
        <Alert variant="warning">
          <Clock3Icon />
          <AlertTitle>{t('deployment.history.next.recoveryPending')}</AlertTitle>
          <AlertDescription>{t('deployment.history.next.recoveryPendingDescription')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={focusRecovery}>{t('deployment.recovery.open')}</Button></AlertAction>
        </Alert>
      );
    }
    return null;
  };

  return (
    <>
      <Card
        size="sm"
        radius="compact"
        className={display === 'dialog'
          ? 'min-h-0 max-h-[min(42rem,calc(100vh-2rem))] rounded-none ring-0'
          : undefined}
      >
        <CardHeader>
          <CardTitle>{t('deployment.history.title')}</CardTitle>
          <CardDescription>{t('deployment.history.description')}</CardDescription>
          <CardAction className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={runsLoading}
              onClick={() => void loadRunHistory(true).catch(() => undefined)}
            >
              {runsLoading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t('common.refresh')}
            </Button>
            {display === 'dialog' && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.close')}
                onClick={onClose}
              >
                <XIcon />
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent
          className={cn(
            'flex flex-col gap-2',
            display === 'dialog'
              && 'native-scrollbar-default min-h-0 max-h-[min(32rem,calc(100vh-12rem))] overflow-y-auto',
          )}
        >
          {!runsLoading && runs.length === 0 ? (
            <div className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
              <HistoryIcon aria-hidden className="size-5" />
              {t('deployment.history.empty')}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('deployment.history.list')}>
              {runs.map((item) => {
                const itemWorkflow = workflows.find((candidate) => candidate.id === item.workflowId);
                return (
                  <Button
                    key={item.id}
                    variant="outline"
                    className="h-auto min-w-0 items-start justify-start p-3 text-left"
                    onClick={() => void selectRun(item.id).catch(() => undefined)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{itemWorkflow?.name ?? item.workflowId}</span>
                        <Badge variant={statusVariant(item.status)}>{t(`deployment.plan.status.${item.status}` as LocaleKey)}</Badge>
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{item.id}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.approvalSummary.frozen.currentRelease?.releaseId ?? t('deployment.summary.none')}
                        {' → '}{item.approvalSummary.frozen.targetRelease.releaseId}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          )}
          {runsNextCursor && (
            <Button
              variant="ghost"
              disabled={runsLoadingMore}
              onClick={() => void loadRunHistory(false).catch(() => undefined)}
            >
              {runsLoadingMore && <Spinner data-icon="inline-start" />}
              {t('deployment.history.loadMore')}
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedRunId)} onOpenChange={(open) => { if (!open) void selectRun(null); }}>
        <DialogContent className="flex h-[min(52rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-4xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{workflow?.name ?? t('deployment.history.detailTitle')}</DialogTitle>
            <DialogDescription>{run?.id ?? selectedRunId}</DialogDescription>
          </DialogHeader>
          {runDetailLoading || !runDetail ? (
            <div className="flex min-h-48 flex-1 items-center justify-center" role="status">
              <Spinner />
              <span className="sr-only">{t('deployment.history.loadingDetail')}</span>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1 pr-3">
              <div className="flex flex-col gap-4 pb-2">
                {renderNextStep()}
                <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                  <div><span className="text-muted-foreground">{t('deployment.history.status')}</span><div><Badge variant={statusVariant(runDetail.run.status)}>{t(`deployment.plan.status.${runDetail.run.status}` as LocaleKey)}</Badge></div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.environment')}</span><div>{profile?.name ?? runDetail.run.approvalSummary.frozen.target.profileId}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.target')}</span><div>{runDetail.run.approvalSummary.frozen.target.username}@{runDetail.run.approvalSummary.frozen.target.host}:{runDetail.run.approvalSummary.frozen.target.port}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.source')}</span><div className="break-all font-mono text-xs">{runDetail.run.approvalSummary.frozen.sourceRevision.revision}{runDetail.run.approvalSummary.frozen.sourceRevision.dirty ? ' *' : ''}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.releasePath')}</span><div className="font-mono text-xs">{runDetail.run.approvalSummary.frozen.currentRelease?.releaseId ?? '—'} → {runDetail.run.approvalSummary.frozen.targetRelease.releaseId}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.rollbackRelease')}</span><div className="font-mono text-xs">{runDetail.run.approvalSummary.frozen.rollbackRelease?.releaseId ?? '—'}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.started')}</span><div>{formatMoment(runDetail.run.startedAt, locale)}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.finished')}</span><div>{formatMoment(runDetail.run.finishedAt, locale)}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.history.duration')}</span><div>{formatDuration(runDetail.run)}</div></div>
                </div>

                <div className="rounded-lg border p-3 text-sm">
                  <div className="font-medium">{t('deployment.history.approvalSummary')}</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div><span className="text-muted-foreground">{t('deployment.approval.digest')}</span><div className="break-all font-mono text-xs">{runDetail.run.approvalDigest}</div></div>
                    <div><span className="text-muted-foreground">{t('deployment.plan.expires')}</span><div>{formatMoment(runDetail.run.approvalSummary.expiresAt, locale)}</div></div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {runDetail.run.approvalSummary.actions.map((action) => (
                      <Badge key={action} variant="secondary">{t(`deployment.plan.action.${action}` as LocaleKey)}</Badge>
                    ))}
                  </div>
                  {runDetail.run.approvalSummary.frozen.preflight.checks.length > 0 && (
                    <div className="mt-3 flex flex-col gap-1" aria-label={t('deployment.approval.preflight')}>
                      {runDetail.run.approvalSummary.frozen.preflight.checks.map((check) => (
                        <div key={check.code} className="flex items-start gap-2 rounded-md bg-muted/40 p-2 text-xs">
                          <Badge variant={check.outcome === 'blocked' ? 'destructive' : 'outline'}>{check.outcome}</Badge>
                          <span className="min-w-0 flex-1 break-words">{check.code} · {check.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div aria-label={t('deployment.history.timeline')}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="font-medium">{t('deployment.history.timeline')}</div>
                    {runDetail.nextBeforeSequence && (
                      <Button size="sm" variant="ghost" onClick={() => void loadEarlierRunEvents().catch(() => undefined)}>
                        {t('deployment.history.loadEarlierEvents')}
                      </Button>
                    )}
                  </div>
                  <ol className="flex flex-col gap-2">
                    {runDetail.events.map((event) => {
                      const evidence = evidenceSummary(event);
                      return (
                        <li key={event.sequence} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border p-3 text-sm">
                          <Badge variant="outline">{event.sequence}</Badge>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{t(`deployment.history.event.${event.eventKind}` as LocaleKey)}</span>
                              {event.status && <Badge variant={statusVariant(event.status)}>{t(`deployment.plan.status.${event.status}` as LocaleKey)}</Badge>}
                              <time className="text-xs text-muted-foreground">{formatMoment(event.recordedAt, locale)}</time>
                            </div>
                            <p className="mt-1 break-words text-muted-foreground">{event.summary}</p>
                            {evidence && <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{evidence}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>
            </ScrollArea>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={!runDetail || exporting} onClick={() => void exportAudit()}>
              {exporting ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
              {t('deployment.history.exportAudit')}
            </Button>
            <Button variant="outline" onClick={() => void selectRun(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

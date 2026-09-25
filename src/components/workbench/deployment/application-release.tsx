import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type { DeploymentApplicationEntry, DeploymentReadinessReport } from '@/lib/deployment/applications';
import type { DeploymentRunDetail, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { invokeCheckDeploymentReadiness, invokeObserveDeploymentService } from '@/lib/ipc/tauri';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import { DeploymentWorkflowRuntimeView, PreparationProgress } from '../deployment-workflow-runtime';
import { deploymentStatusLabel, formatDeploymentDate } from './runtime-utils';
import { getErrorMessage } from '@/lib/error';

const key = (name: string): LocaleKey => `deployment.release.${name}` as LocaleKey;

export function ServiceObservation({ detail }: { detail: DeploymentRunDetail | null }): React.JSX.Element {
  const { t } = useI18n();
  const observation = detail?.serviceObservation;
  // Evidence remains a dated observation; it is never a continuous online badge.
  const evidence = detail?.outputs.filter((output) => output.outputKind === 'evidence') ?? [];
  return <Alert data-testid="deployment-service-observation">
    <AlertTitle>{t(key('service'))}</AlertTitle>
    <AlertDescription>
      <p>{t(key(observation?.status === 'passed' ? 'observedPassed' : 'unknown'))}</p>
      {observation && <p>{formatDeploymentDate(observation.checkedAt)}</p>}
      <p>{t(key('observationHelp'))}</p>
      {observation?.reason && <details><summary>{t('deployment.application.details')}</summary><p className="break-all">{observation.reason}</p></details>}
      {evidence.length > 0 && <details><summary>{t(key('releaseChecks'))}</summary>{evidence.map((output) => <div key={`${output.nodeId}-${output.outputName}`}>
        <p>{formatDeploymentDate(output.createdAt)}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(output.value, null, 2)}</pre>
      </div>)}</details>}
    </AlertDescription>
  </Alert>;
}

export function ApplicationRelease({ entry, workflow, report, onReport, admissionsEnabled }: {
  entry: DeploymentApplicationEntry; workflow: DeploymentWorkflowRecord;
  report: DeploymentReadinessReport | null; onReport: (report: DeploymentReadinessReport) => void;
  admissionsEnabled: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const profile = useProfileStore((store) => store.profiles.find((item) => item.id === entry.environment.config.connectionProfileId));
  const [open, setOpen] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [approvalRequest, setApprovalRequest] = React.useState(0);
  const [now, setNow] = React.useState(Date.now);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const returnFocusRef = React.useRef<HTMLButtonElement | null>(null);
  const detailCloseRef = React.useRef<HTMLButtonElement>(null);
  const handledNotice = React.useRef<number | null>(null);
  const addToast = useToastStore((store) => store.addToast);
  React.useEffect(() => {
    if (useDeploymentWorkflowRunStore.getState().workflowId !== workflow.id) void useDeploymentWorkflowRunStore.getState().loadWorkflow(workflow.id).catch(() => undefined);
  }, [workflow.id]);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activeStatus = state.detail?.summary.status;
  React.useEffect(() => {
    if (open || !activeStatus || !['approved', 'in_progress', 'verifying', 'reconciling', 'cancel_requested'].includes(activeStatus)) return;
    const timer = window.setInterval(() => { void useDeploymentWorkflowRunStore.getState().refreshSelectedRun(); }, 1500);
    return () => window.clearInterval(timer);
  }, [open, activeStatus]);
  React.useEffect(() => {
    if (!state.notice || handledNotice.current === state.notice.id) return;
    handledNotice.current = state.notice.id;
    addToast(t(`deployment.runtime.toast.${state.notice.kind}` as LocaleKey), 'success');
    state.clearNotice();
  }, [state.notice, state.clearNotice, addToast, t]);
  const ready = report !== null && now - report.checkedAt < 900_000 && report.items.length > 0
    && report.items.every((item) => item.status === 'passed' || item.status === 'notice');
  const busy = checking || state.preparing || state.action !== null || state.loading;
  const prepare = (): void => {
    setOpen(true);
    void state.prepare(workflow).then(() => setApprovalRequest((current) => current + 1)).catch(() => undefined);
  };
  const current = state.releases.find((release) => release.position === 'current');
  const detail = state.workflowId === workflow.id ? state.detail : null;
  return <section className="flex min-w-0 flex-col gap-3" aria-label={t(key('overview'))}>
    <dl className="grid min-w-0 gap-2 @min-[36rem]:grid-cols-2">
      <div><dt>{t('deployment.application.connectionProfileId')}</dt><dd className="break-all">{profile ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}` : t('deployment.runtime.target.unavailable')}</dd></div>
      <div><dt>{t(key('current'))}</dt><dd className="break-all">{current?.releaseId ?? t(key('neverReleased'))}</dd></div>
      <div><dt>{t('deployment.application.service')}</dt><dd>{entry.environment.config.service} · {entry.environment.config.bindAddress}:{entry.environment.config.hostPort}</dd></div>
      <div><dt>{t('deployment.application.accessUrl')}</dt><dd className="break-all">{entry.environment.config.accessUrl || t(key('noPublicEntry'))}</dd></div>
    </dl>
    <p>{t(key('prepareHelp'))}</p>
    <div className="flex flex-wrap gap-2">
      <Button ref={triggerRef} disabled={busy || !ready || !admissionsEnabled} onClick={(event) => { returnFocusRef.current = event.currentTarget; prepare(); }}>{t(key('prepare'))}</Button>
      <Button variant="outline" disabled={busy} onClick={() => {
        setChecking(true);
        void invokeCheckDeploymentReadiness(entry, true).then(onReport)
          .catch((error: unknown) => addToast(getErrorMessage(error), 'error')).finally(() => setChecking(false));
      }}>{t('deployment.application.check')}</Button>
      <Button variant="outline" disabled={state.workflowId !== workflow.id} onClick={(event) => { returnFocusRef.current = event.currentTarget; setOpen(true); }}>{t(key('runs'))}</Button>
    </div>
    <ServiceObservation detail={detail?.summary.targetRelease.releaseId === current?.releaseId ? detail : null} />
    <Button variant="outline" disabled={busy || !current} onClick={() => {
      setChecking(true);
      const runId = current?.sourceRunId;
      const refresh = runId ? invokeObserveDeploymentService(runId).then(() => state.selectRun(runId)) : Promise.reject(new Error(t(key('unknown'))));
      void refresh.catch((error: unknown) => addToast(getErrorMessage(error), 'error')).finally(() => setChecking(false));
    }}>{t(key('observe'))}</Button>
    {detail && <p>{t(key('latestResult'))}: <Badge variant="outline">{deploymentStatusLabel(detail.summary.status, t)}</Badge> · {formatDeploymentDate(detail.summary.updatedAt)}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent finalFocus={returnFocusRef} className="flex h-[min(52rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-6xl flex-col overflow-hidden p-0" data-testid="deployment-release-detail">
        <DialogHeader className="shrink-0 px-4 pt-4 pr-12"><DialogTitle>{entry.application.name} · {entry.environment.name}</DialogTitle><DialogDescription>{t(key('detailHelp'))}</DialogDescription></DialogHeader>
        {state.preparing ? <ScrollArea className="min-h-0 flex-1"><div className="p-4"><PreparationProgress /></div></ScrollArea> : <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {state.error && (!state.detail || state.errorContext !== 'prepare') && <Alert variant="warning" className="mx-4"><AlertTitle>{t('deployment.application.error')}</AlertTitle><AlertDescription><p>{t(key('prepareFailed'))}</p><details><summary>{t('deployment.application.details')}</summary><p className="break-all">{state.error}</p></details></AlertDescription></Alert>}
          <DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} admissionsEnabled={admissionsEnabled} onDeploy={prepare} canDeploy={ready && !busy} approvalRequest={approvalRequest} onApprovalHandled={() => setApprovalRequest(0)} deployTriggerRef={detailCloseRef} />
        </div>}
        <DialogFooter className="shrink-0 px-4 pb-4">
          {state.preparing && <Button variant="outline" disabled={!state.preparationRunId} onClick={() => void state.cancelPreparation().catch((error: unknown) => addToast(getErrorMessage(error), 'error'))}>{t('deployment.runtime.cancel.action')}</Button>}
          <Button ref={detailCloseRef} variant="outline" onClick={() => setOpen(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

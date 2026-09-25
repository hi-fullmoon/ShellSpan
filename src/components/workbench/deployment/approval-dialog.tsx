import React from 'react';
import { AlertTriangleIcon, PlayIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentJsonObject, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { getErrorMessage } from '@/lib/error';
import { useProfileStore } from '@/stores/profileStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import {
  deploymentRuntimeKey,
  formatDeploymentBytes,
} from './runtime-utils';

function profileLabel(
  profile: { name: string; username: string; host: string; port: number } | undefined,
  fallback: string,
): string {
  return profile ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}` : fallback;
}

const ApprovalSection: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="flex flex-col gap-2 py-3 text-sm">
    <h3 className="text-sm font-medium">{title}</h3>
    {children}
  </section>
);

export interface ApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: DeploymentWorkflowRecord;
  admissionsEnabled?: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export const ApprovalDialog: React.FC<ApprovalDialogProps> = ({
  open,
  onOpenChange,
  workflow,
  admissionsEnabled = true,
  returnFocusRef,
}) => {
  const { t, locale } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const detail = useDeploymentWorkflowRunStore((state) => state.detail);
  const action = useDeploymentWorkflowRunStore((state) => state.action);
  const approveAndStart = useDeploymentWorkflowRunStore((state) => state.approveAndStart);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const summary = detail?.approvalSummary ?? null;
  const invalid = !summary
    || !detail
    || !['awaiting_approval', 'approved'].includes(detail.summary.status)
    || detail.summary.expired
    || detail.summary.planDrifted
    || now > detail.summary.expiresAt;
  const profile = profiles.find((item) => item.id === summary?.target.connectionProfileId);
  const frozenDisplay = summary?.preflight.display;
  const frozenAddress = frozenDisplay && typeof frozenDisplay === 'object' && !Array.isArray(frozenDisplay)
    ? frozenDisplay as DeploymentJsonObject : null;
  const frozenHost = frozenAddress
    ? `${String(frozenAddress.username ?? '')}@${String(frozenAddress.host ?? '')}:${String(frozenAddress.port ?? '')}` : null;
  const verificationNames = summary?.verificationNodes.map((nodeId) => (
    workflow.definition.nodes.find((node) => node.id === nodeId)?.displayName
      ?? t('deployment.runtime.verification.fallback')
  )) ?? [];

  React.useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  React.useEffect(() => {
    if (open) setSubmitError(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) returnFocusRef?.current?.focus(); }}
    >
      <DialogContent
        initialFocus={cancelRef}
        className="flex h-[min(46rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        data-testid="deployment-approval-dialog"
      >
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>{t('deployment.runtime.approval.title')}</DialogTitle>
          <DialogDescription>{t('deployment.runtime.approval.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-4">
            {submitError && (
              <Alert variant="destructive" className="mt-4" data-testid="deployment-approval-error">
                <AlertTriangleIcon />
                <AlertTitle>{t('deployment.runtime.approval.errorTitle')}</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            {summary && (
              <>
                {invalid && (
                  <Alert variant="warning" className="mt-4">
                    <AlertTriangleIcon />
                    <AlertTitle>{t('deployment.runtime.approval.invalidTitle')}</AlertTitle>
                    <AlertDescription>{t('deployment.runtime.approval.invalidDescription')}</AlertDescription>
                  </Alert>
                )}
                <ApprovalSection title={t('deployment.runtime.approval.what')}>
                  <dl className="grid gap-2 @min-[36rem]:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">{t('deployment.runtime.source')}</dt>
                      <dd className="break-all">{summary.source.revision}{summary.source.dirty ? ` · ${t('deployment.runtime.dirty')}` : ''}</dd>
                      {summary.source.changedFiles && <ul>{summary.source.changedFiles.map((file) => <li className="break-all" key={file}>{file}</li>)}</ul>}
                    </div>
                    {summary.artifacts.map((artifact) => (
                      <div key={artifact.handle.artifactReference} className="min-w-0">
                        <dt className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{artifact.componentCount}</Badge>
                          <span>{artifact.artifactType}</span>
                        </dt>
                        <dd className="mt-1 flex flex-col gap-1">
                          <span>{formatDeploymentBytes(artifact.totalSize)}</span>
                          <code className="break-all text-xs text-muted-foreground">{artifact.handle.contentDigest}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </ApprovalSection>
                <Separator />
                <ApprovalSection title={t('deployment.runtime.approval.where')}>
                  <div>{frozenHost ?? profileLabel(profile, t('deployment.runtime.target.unavailable'))}</div>
                  <code className="break-all text-xs text-muted-foreground">{summary.target.remoteRoot}</code>
                  <div>{t('deployment.runtime.releasePath', {
                    current: summary.currentRelease?.releaseId ?? t('deployment.runtime.none'),
                    target: summary.targetRelease.releaseId,
                  })}</div>
                </ApprovalSection>
                <Separator />
                <ApprovalSection title={t('deployment.runtime.approval.effects')}>
                  <p>{t('deployment.release.interruption')}</p>
                  {summary.releaseReview?.configuration.filter((node) => node.type === 'deploy.compose').map((node) => <div key={node.nodeId}>
                    <p>{t('deployment.application.projectName')}: {String(node.config.projectName ?? '')}</p>
                    <p>{t('deployment.application.service')}: {Array.isArray(node.config.services) ? node.config.services.join(', ') : ''}</p>
                  </div>)}
                  {[...new Set(summary.artifacts.flatMap((artifact) => artifact.components).map((component) => component.annotations.imageReference).filter(Boolean))].map((reference) => <p className="break-all" key={reference}>{reference}</p>)}
                  {summary.effects.map((effect) => (
                    <div key={effect.nodeId} className="flex items-center justify-between gap-2">
                      <span>{effect.displayName}</span>
                      <Badge variant="outline">
                        {t(deploymentRuntimeKey(`deployment.editor.effect.${effect.effectClass}`))}
                      </Badge>
                    </div>
                  ))}
                </ApprovalSection>
                <Separator />
                <ApprovalSection title={t('deployment.runtime.approval.verify')}>
                  {summary.releaseReview ? summary.releaseReview.configuration.filter((node) => node.type === 'verify.http').map((node) => <div key={node.nodeId}>
                    <p>{node.name}</p><p className="break-all">{String(node.config.scheme)}://127.0.0.1:{String(node.config.port)}{String(node.config.path)}</p>
                    <p>{t('deployment.release.expectedStatuses')}: {Array.isArray(node.config.expectedStatuses) ? node.config.expectedStatuses.join(', ') : ''}</p>
                  </div>) : verificationNames.map((name) => <div key={name}>{name}</div>)}
                  {verificationNames.length === 0 && <div>{t('deployment.runtime.verification.none')}</div>}
                </ApprovalSection>
                <Separator />
                <ApprovalSection title={t('deployment.runtime.approval.failure')}>
                  <div>{summary.releaseReview?.automaticRestore
                    ? t('deployment.runtime.restore.enabled')
                    : t('deployment.runtime.restore.disabled')}</div>
                  <div>{summary.previousRelease
                    ? t('deployment.runtime.restore.release', { release: summary.previousRelease.releaseId })
                    : t('deployment.runtime.restore.noPrevious')}</div>
                  <div className="text-muted-foreground">{t('deployment.runtime.restore.unknown')}</div>
                </ApprovalSection>
                <ApprovalSection title={t('deployment.release.frozenConfiguration')}>
                  <p>{t('deployment.release.frozenHelp')}</p>
                  <p>{t('deployment.release.expires')}: {new Date(summary.expiresAt).toLocaleString(locale)}</p>
                  <p className="break-all">{summary.source.binding?.includedUntracked.join(', ')}</p>
                  {summary.releaseReview?.configuration.map((node) => <details key={node.nodeId}>
                    <summary>{node.name}</summary>
                    <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(node.config, null, 2)}</pre>
                  </details>)}
                </ApprovalSection>
              </>
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 p-4">
          <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            disabled={!admissionsEnabled || invalid || action === 'approve'}
            onClick={() => {
              setSubmitError(null);
              void approveAndStart()
                .then(() => onOpenChange(false))
                .catch((error: unknown) => {
                  useDeploymentWorkflowRunStore.getState().clearError();
                  setSubmitError(getErrorMessage(error));
                });
            }}
          >
            {action === 'approve'
              ? <Spinner data-icon="inline-start" />
              : <PlayIcon data-icon="inline-start" />}
            {t(detail?.summary.status === 'approved'
              ? 'deployment.runtime.startApproved'
              : 'deployment.runtime.approveAndRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

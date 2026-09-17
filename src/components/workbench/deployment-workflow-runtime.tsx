import React from 'react';
import {
  AlertTriangleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  Clock3Icon,
  EyeIcon,
  FileArchiveIcon,
  HistoryIcon,
  PackageCheckIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SquareIcon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { invokeExportDeploymentRunAudit } from '@/lib/ipc/tauri';
import { topologyOrder } from '@/lib/deployment/editor';
import type {
  DeploymentArtifactReference,
  DeploymentJsonValue,
  DeploymentNodeAttemptRecord,
  DeploymentReleaseRecord,
  DeploymentRunNodeStatus,
  DeploymentRunNodeRecord,
  DeploymentRunStatus,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';

type RuntimeViewKind = 'prepare' | 'runs' | 'versions';
type Translate = (key: LocaleKey, values?: Record<string, string | number>) => string;

function key(value: string): LocaleKey {
  return value as LocaleKey;
}

function formatDate(value: number | null | undefined): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '—';
}

function formatDuration(startedAt: number | null | undefined, finishedAt: number | null | undefined): string {
  if (!startedAt) return '—';
  const duration = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${Math.round(duration / 1_000)} s`;
  return `${Math.round(duration / 60_000)} min`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
}

function jsonObject(value: DeploymentJsonValue | undefined): Readonly<Record<string, DeploymentJsonValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, DeploymentJsonValue>>
    : null;
}

function statusBadgeVariant(status: DeploymentRunStatus | DeploymentRunNodeStatus | string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'succeeded' || status === 'compensated') return 'default';
  if (status === 'failed' || status === 'state_unknown') return 'destructive';
  if (status === 'in_progress' || status === 'running' || status === 'verifying' || status === 'reconciling') return 'secondary';
  return 'outline';
}

function statusLabel(status: string, t: Translate): string {
  return t(key(`deployment.runtime.status.${status}`));
}

function eventLabel(summaryKey: string, t: Translate): string {
  return t(key(summaryKey));
}

function profileLabel(
  profile: { name: string; username: string; host: string; port: number } | undefined,
  fallback: string,
): string {
  return profile ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}` : fallback;
}

function RunStatusAlert({ status, onReconcile, evidenceGaps = [] }: {
  status: DeploymentRunStatus;
  onReconcile: () => void;
  evidenceGaps?: readonly string[];
}): React.ReactNode {
  const { t } = useI18n();
  if (status === 'state_unknown') {
    return (
      <Alert variant="destructive" role="status">
        <AlertTriangleIcon />
        <AlertTitle>{t('deployment.runtime.unknown.title')}</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-1">
            <span>{t('deployment.runtime.unknown.description')}</span>
            {evidenceGaps.length > 0 && <span>{t('deployment.runtime.unknown.gaps', { gaps: evidenceGaps.join(', ') })}</span>}
          </div>
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onReconcile}>
            <ShieldCheckIcon data-icon="inline-start" />
            {t('deployment.runtime.reconcile')}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (status === 'awaiting_approval') {
    return (
      <Alert role="status">
        <Clock3Icon />
        <AlertTitle>{t('deployment.runtime.awaitingApproval.title')}</AlertTitle>
        <AlertDescription>{t('deployment.runtime.awaitingApproval.description')}</AlertDescription>
      </Alert>
    );
  }
  if (['approved', 'in_progress', 'verifying', 'reconciling', 'cancel_requested'].includes(status)) {
    return (
      <Alert role="status">
        <Spinner />
        <AlertTitle>{statusLabel(status, t)}</AlertTitle>
        <AlertDescription>{t('deployment.runtime.active.description')}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function ApprovalGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Card size="sm" variant="outline" radius="compact">
      <CardHeader><CardTitle role="heading" aria-level={3}>{title}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">{children}</CardContent>
    </Card>
  );
}

function ApprovalDialog({ open, onOpenChange, workflow, returnFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: DeploymentWorkflowRecord;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.ReactNode {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const detail = useDeploymentWorkflowRunStore((state) => state.detail);
  const action = useDeploymentWorkflowRunStore((state) => state.action);
  const approveAndStart = useDeploymentWorkflowRunStore((state) => state.approveAndStart);
  const approveRef = React.useRef<HTMLButtonElement>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const summary = detail?.approvalSummary ?? null;
  const invalid = !summary || !detail || detail.summary.expired || detail.summary.planDrifted || now > detail.summary.expiresAt;
  const profile = profiles.find((item) => item.id === summary?.target.connectionProfileId);
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) returnFocusRef?.current?.focus(); }}
    >
      <DialogContent
        initialFocus={approveRef}
        className="flex h-[min(46rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 p-4">
          <DialogTitle>{t('deployment.runtime.approval.title')}</DialogTitle>
          <DialogDescription>{t('deployment.runtime.approval.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 px-4 pb-4">
            {summary && (
              <>
                {invalid && (
                  <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertTitle>{t('deployment.runtime.approval.invalidTitle')}</AlertTitle>
                    <AlertDescription>{t('deployment.runtime.approval.invalidDescription')}</AlertDescription>
                  </Alert>
                )}
                <ApprovalGroup title={t('deployment.runtime.approval.what')}>
                  <div><span className="text-muted-foreground">{t('deployment.runtime.source')}</span><div>{summary.source.revision}{summary.source.dirty ? ` · ${t('deployment.runtime.dirty')}` : ''}</div></div>
                  {summary.artifacts.map((artifact) => (
                    <div key={artifact.handle.artifactReference} className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{artifact.componentCount}</Badge>
                        <span>{artifact.artifactType}</span>
                        <span className="text-muted-foreground">{formatBytes(artifact.totalSize)}</span>
                      </div>
                      <code className="break-all text-xs text-muted-foreground">{artifact.handle.contentDigest}</code>
                      <div className="flex flex-wrap gap-1">
                        {artifact.components.map((component) => <Badge key={component.name} variant="outline">{component.name}</Badge>)}
                      </div>
                    </div>
                  ))}
                </ApprovalGroup>
                <ApprovalGroup title={t('deployment.runtime.approval.where')}>
                  <div>{profileLabel(profile, t('deployment.runtime.target.unavailable'))}</div>
                  <code className="break-all text-xs text-muted-foreground">{summary.target.remoteRoot}</code>
                  <div>{t('deployment.runtime.releasePath', { current: summary.currentRelease?.releaseId ?? t('deployment.runtime.none'), target: summary.targetRelease.releaseId })}</div>
                </ApprovalGroup>
                <ApprovalGroup title={t('deployment.runtime.approval.effects')}>
                  {summary.effects.map((effect) => (
                    <div key={effect.nodeId} className="flex items-center justify-between gap-2">
                      <span>{effect.displayName}</span>
                      <Badge variant="outline">{t(key(`deployment.editor.effect.${effect.effectClass}`))}</Badge>
                    </div>
                  ))}
                </ApprovalGroup>
                <ApprovalGroup title={t('deployment.runtime.approval.verify')}>
                  {verificationNames.map((name) => <div key={name}>{name}</div>)}
                  {verificationNames.length === 0 && <div>{t('deployment.runtime.verification.none')}</div>}
                </ApprovalGroup>
                <ApprovalGroup title={t('deployment.runtime.approval.failure')}>
                  <div>{workflow.definition.policy.automaticRestore ? t('deployment.runtime.restore.enabled') : t('deployment.runtime.restore.disabled')}</div>
                  <div>{summary.previousRelease ? t('deployment.runtime.restore.release', { release: summary.previousRelease.releaseId }) : t('deployment.runtime.restore.noPrevious')}</div>
                  <div className="text-muted-foreground">{t('deployment.runtime.restore.unknown')}</div>
                </ApprovalGroup>
              </>
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            ref={approveRef}
            autoFocus
            disabled={invalid || action === 'approve'}
            onClick={() => void approveAndStart().then(() => onOpenChange(false)).catch(() => undefined)}
          >
            {action === 'approve' ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
            {t('deployment.runtime.approveAndRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactDrawer(): React.ReactNode {
  const { t } = useI18n();
  const artifact = useDeploymentWorkflowRunStore((state) => state.artifact);
  const clearArtifact = useDeploymentWorkflowRunStore((state) => state.clearArtifact);
  return (
    <Drawer open={artifact !== null} onOpenChange={(open) => { if (!open) clearArtifact(); }}>
      <DrawerContent className="flex min-h-0 flex-col gap-0 p-0" data-testid="deployment-artifact-drawer">
        <DrawerHeader className="shrink-0 p-4">
          <DrawerTitle>{t('deployment.runtime.artifact.title')}</DrawerTitle>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          {artifact && (
            <div className="flex flex-col gap-3 px-4 pb-4">
              <Card size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{artifact.manifest.artifactType}</CardTitle>
                  <CardDescription>{t('deployment.runtime.artifact.components', { count: artifact.componentCount })} · {formatBytes(artifact.totalSize)}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <code className="break-all text-xs">{artifact.handle.contentDigest}</code>
                  <code className="break-all text-xs text-muted-foreground">{artifact.handle.manifestDigest}</code>
                  <div>{t('deployment.runtime.artifact.source')}: {artifact.manifest.source.revision}{artifact.manifest.source.dirty ? ` · ${t('deployment.runtime.dirty')}` : ''}</div>
                  <div>{t('deployment.runtime.artifact.producer')}: {artifact.manifest.producer.nodeType} v{artifact.manifest.producer.nodeTypeVersion}</div>
                </CardContent>
              </Card>
              <Card size="sm" variant="outline" radius="compact">
                <CardHeader><CardTitle>{t('deployment.runtime.artifact.manifest')}</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {artifact.manifest.components.map((component) => (
                    <Card key={component.name} size="sm" variant="outline" radius="compact">
                      <CardHeader>
                        <CardTitle>{component.name}</CardTitle>
                        <CardDescription>{component.mediaType} · {formatBytes(component.size)}</CardDescription>
                        <CardAction><Badge variant="outline">{component.role}</Badge></CardAction>
                      </CardHeader>
                      <CardContent><code className="break-all text-xs text-muted-foreground">{component.digest}</code></CardContent>
                    </Card>
                  ))}
                </CardContent>
              </Card>
              <Card size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{t('deployment.runtime.artifact.retention')}</CardTitle>
                  <CardAction><Badge variant={artifact.retention.protected ? 'default' : 'outline'}>{artifact.retention.protected ? t('deployment.runtime.artifact.protected') : t('deployment.runtime.artifact.unprotected')}</Badge></CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <div>{t('deployment.runtime.artifact.referenceCount', { count: artifact.retention.referenceCount })}</div>
                  <div>{t('deployment.runtime.artifact.leaseCount', { count: artifact.retention.leaseCount })}</div>
                  <div>{artifact.retention.currentRelease ? t('deployment.runtime.version.current') : artifact.retention.previousRelease ? t('deployment.runtime.version.previous') : t('deployment.runtime.artifact.notRelease')}</div>
                  {artifact.references.map((reference, index) => (
                    <div key={`${reference.referenceKind}-${reference.ownerId}-${index}`} className="flex items-center justify-between gap-2">
                      <span>{t(key(`deployment.runtime.artifact.reference.${reference.referenceKind}`))}</span>
                      <code className="truncate text-xs text-muted-foreground">{reference.ownerId}</code>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </ScrollArea>
        <DrawerFooter className="shrink-0 border-t p-4">
          <Button variant="outline" onClick={clearArtifact}>{t('common.close')}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function EvidenceDialog({ open, onOpenChange, returnFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.ReactNode {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const node = state.nodes.find((item) => item.nodeId === state.selectedNodeId) ?? null;
  const outputs = state.detail?.outputs.filter((output) => output.nodeId === node?.nodeId) ?? [];
  const receipts = state.detail?.receipts.filter((receipt) => receipt.nodeId === node?.nodeId) ?? [];
  const events = state.events.filter((event) => event.nodeId === node?.nodeId);
  const [exporting, setExporting] = React.useState(false);
  const exportAudit = async (): Promise<void> => {
    const runId = state.selectedRunId;
    if (!runId || exporting) return;
    setExporting(true);
    try {
      const result = await invokeExportDeploymentRunAudit(runId);
      if (result.saved) {
        useToastStore.getState().addToast(t('deployment.history.auditExported'), 'success');
      }
    } catch {
      useToastStore.getState().addToast(t('deployment.history.auditExportFailed'), 'error');
    } finally {
      setExporting(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) returnFocusRef?.current?.focus(); }}
    >
      <DialogContent className="flex h-[min(44rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 p-4">
          <DialogTitle>{t('deployment.runtime.evidence.title')}</DialogTitle>
          <DialogDescription>{node?.nodeId ? t('deployment.runtime.evidence.description', { node: node.nodeId }) : t('deployment.runtime.evidence.empty')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 px-4 pb-4">
            {outputs.map((output) => (
              <Card key={output.outputName} size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{output.outputName}</CardTitle>
                  <CardAction><Badge variant="outline">{t(key(`deployment.runtime.output.${output.outputKind}`))}</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(output.value, null, 2)}</pre>
                </CardContent>
              </Card>
            ))}
            {receipts.map((receipt) => (
              <Card key={receipt.operationId} size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{receipt.receiptType}</CardTitle>
                  <CardDescription>{t('deployment.runtime.attemptNumber', { attempt: receipt.attempt })}</CardDescription>
                </CardHeader>
                <CardContent><code className="break-all text-xs text-muted-foreground">{receipt.payloadDigest}</code></CardContent>
              </Card>
            ))}
            {events.length > 0 && (
              <Card size="sm" variant="outline" radius="compact">
                <CardHeader><CardTitle>{t('deployment.runtime.logs')}</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2 font-mono text-xs">
                  {events.map((event) => (
                    <div key={event.sequence}>#{event.sequence} · {eventLabel(event.summaryKey, t)}</div>
                  ))}
                </CardContent>
              </Card>
            )}
            {outputs.length === 0 && receipts.length === 0 && events.length === 0 && (
              <EmptyState icon={<ScrollTextIcon />} title={t('deployment.runtime.evidence.empty')} description={t('deployment.runtime.evidence.emptyDescription')} />
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t p-4">
          <Button variant="outline" onClick={() => void exportAudit()} disabled={!state.selectedRunId || exporting}>
            {exporting ? <Spinner data-icon="inline-start" /> : <ScrollTextIcon data-icon="inline-start" />}
            {t('deployment.history.exportAudit')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreparationProgress(): React.ReactNode {
  const { t } = useI18n();
  const nodes = useDeploymentWorkflowRunStore((state) => state.preparationNodes);
  const completed = useDeploymentWorkflowRunStore((state) => state.preparationCompleted);
  const total = useDeploymentWorkflowRunStore((state) => state.preparationTotal);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <Alert role="status">
      <Spinner />
      <AlertTitle>{t('deployment.runtime.preparing.title')}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-3">
          <span>{t('deployment.runtime.preparing.description')}</span>
          <Progress value={percent}>
            <ProgressLabel>{nodes.find((node) => node.status === 'running')?.displayName ?? t('deployment.runtime.preparing.plan')}</ProgressLabel>
            <ProgressValue>{() => `${completed}/${total}`}</ProgressValue>
          </Progress>
          <div className="flex flex-wrap gap-1">
            {nodes.map((node) => (
              <Badge key={node.nodeId} variant={node.status === 'succeeded' ? 'default' : node.status === 'running' ? 'secondary' : node.status === 'failed' ? 'destructive' : 'outline'}>{node.displayName}</Badge>
            ))}
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function PrepareView({ workflow, semanticDirty, onOpenApproval }: {
  workflow: DeploymentWorkflowRecord;
  semanticDirty: boolean;
  onOpenApproval: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const awaiting = state.detail?.summary.status === 'awaiting_approval' ? state.detail : null;
  const blocking = awaiting?.summary.expired || awaiting?.summary.planDrifted;
  const requiredCapabilities = workflow.definition.nodes
    .filter((node) => node.type === 'target.preflight')
    .flatMap((node) => Array.isArray(node.config.requiredCapabilities) ? node.config.requiredCapabilities.map(String) : []);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="deployment-prepare-view">
      {semanticDirty && (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>{t('deployment.runtime.drift.unsavedTitle')}</AlertTitle>
          <AlertDescription>{t('deployment.runtime.drift.unsavedDescription')}</AlertDescription>
        </Alert>
      )}
      {state.preparing && <PreparationProgress />}
      {state.error && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{state.error.includes('CAPABILITY') ? t('deployment.runtime.capability.title') : t('deployment.runtime.prepareFailed.title')}</AlertTitle>
          <AlertDescription>{state.error.includes('CAPABILITY') ? t('deployment.runtime.capability.description') : t('deployment.runtime.prepareFailed.description')}</AlertDescription>
        </Alert>
      )}
      {awaiting && (
        <Alert variant={blocking ? 'warning' : 'default'} role="status">
          {blocking ? <AlertTriangleIcon /> : <ShieldCheckIcon />}
          <AlertTitle>{blocking ? t('deployment.runtime.approval.invalidTitle') : t('deployment.runtime.planReady.title')}</AlertTitle>
          <AlertDescription>{blocking ? t('deployment.runtime.approval.invalidDescription') : t('deployment.runtime.planReady.description', { expires: formatDate(awaiting.summary.expiresAt) })}</AlertDescription>
          <AlertAction><Button size="sm" onClick={onOpenApproval}><ShieldCheckIcon data-icon="inline-start" />{t('deployment.runtime.reviewApproval')}</Button></AlertAction>
        </Alert>
      )}
      <div className="grid min-h-0 gap-3 @min-[56rem]:grid-cols-[minmax(0,1fr)_20rem]">
        <Card size="sm" variant="outline" radius="compact">
          <CardHeader>
            <CardTitle>{t('deployment.runtime.prepare.title')}</CardTitle>
            <CardDescription>{t('deployment.runtime.prepare.description')}</CardDescription>
            <CardAction>
              <Button
                size="sm"
                onClick={() => void state.prepare(workflow).then(onOpenApproval).catch(() => undefined)}
                disabled={semanticDirty || !workflow.enabled || state.preparing}
              >
                {state.preparing ? <Spinner data-icon="inline-start" /> : <PackageCheckIcon data-icon="inline-start" />}
                {awaiting && blocking ? t('deployment.runtime.reprepare') : t('deployment.runtime.prepare.action')}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-3 @min-[40rem]:grid-cols-3">
              <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.revision')}</div><div>{workflow.revision}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.nodes')}</div><div>{workflow.definition.nodes.length}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.retention')}</div><div>{workflow.definition.policy.releasesToKeep}</div></div>
            </div>
            {!workflow.enabled && <Alert variant="warning"><AlertTriangleIcon /><AlertTitle>{t('deployment.runtime.workflowDisabled.title')}</AlertTitle><AlertDescription>{t('deployment.runtime.workflowDisabled.description')}</AlertDescription></Alert>}
          </CardContent>
        </Card>
        <Card size="sm" variant="outline" radius="compact">
          <CardHeader>
            <CardTitle>{t('deployment.runtime.capability.required')}</CardTitle>
            <CardAction><Badge variant="secondary">{requiredCapabilities.length}</Badge></CardAction>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1">
            {requiredCapabilities.map((capability) => <Badge key={capability} variant="outline">{t(key(`deployment.editor.capability.${capability}`))}</Badge>)}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function NodeProgress({ node }: { node: DeploymentRunNodeRecord }): React.ReactNode {
  const { t } = useI18n();
  const summary = jsonObject(node.outputSummary);
  const completed = summary && typeof summary.bytes === 'number' ? summary.bytes : node.status === 'succeeded' ? 1 : 0;
  const total = summary && typeof summary.bytes === 'number' ? summary.bytes : 1;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <Progress value={percent} aria-label={t('deployment.runtime.node.progress', { node: node.nodeId })}>
      <ProgressLabel>{statusLabel(node.status, t)}</ProgressLabel>
      <ProgressValue>{() => summary && typeof summary.bytes === 'number' ? formatBytes(summary.bytes) : `${percent}%`}</ProgressValue>
    </Progress>
  );
}

function AttemptSelector({ attempts, selectedAttempt, onChange }: {
  attempts: readonly DeploymentNodeAttemptRecord[];
  selectedAttempt: number | null;
  onChange: (attempt: number) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const options = attempts.map((attempt) => ({
    value: String(attempt.attempt),
    label: `${t('deployment.runtime.attemptNumber', { attempt: attempt.attempt })} · ${statusLabel(attempt.status, t)}`,
  }));
  if (options.length === 0) return null;
  return (
    <Select items={options} value={String(selectedAttempt ?? attempts[0].attempt)} onValueChange={(value) => { if (value) onChange(Number(value)); }}>
      <SelectTrigger size="sm" aria-label={t('deployment.runtime.attempt.select')}><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  );
}

function RunsView({ workflow, onOpenApproval, onOpenEvidence }: {
  workflow: DeploymentWorkflowRecord;
  onOpenApproval: () => void;
  onOpenEvidence: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [selectedAttempt, setSelectedAttempt] = React.useState<number | null>(null);
  const selectedNode = state.nodes.find((node) => node.nodeId === state.selectedNodeId) ?? null;
  const selectedEvents = state.events.filter((event) => event.nodeId === state.selectedNodeId).slice(0, 6);
  const selectedOutputs = state.detail?.outputs.filter((output) => output.nodeId === state.selectedNodeId) ?? [];
  const selectedArtifact = selectedOutputs.find((output) => output.artifactReference)?.artifactReference;
  const orderedNodes = topologyOrder(workflow.definition).map((definitionNode) => (
    state.nodes.find((node) => node.nodeId === definitionNode.id)
  )).filter((node): node is DeploymentRunNodeRecord => Boolean(node));
  const active = state.detail && ['approved', 'in_progress', 'verifying', 'reconciling', 'cancel_requested'].includes(state.detail.summary.status);

  React.useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => { void state.refreshSelectedRun().catch(() => undefined); }, 1_500);
    return () => window.clearInterval(timer);
  }, [active, state]);

  React.useEffect(() => {
    setSelectedAttempt(state.attempts[0]?.attempt ?? null);
  }, [state.attempts]);

  if (state.loading && state.runs.length === 0) return <PanelLoadingState label={t('deployment.runtime.loading')} />;
  if (state.runs.length === 0) {
    return <EmptyState icon={<HistoryIcon />} title={t('deployment.runtime.runs.empty')} description={t('deployment.runtime.runs.emptyDescription')} />;
  }

  return (
    <div className="grid min-h-0 flex-1 gap-3 @min-[64rem]:grid-cols-[18rem_minmax(0,1fr)]" data-testid="deployment-runs-view">
      <Card className="min-h-0" size="sm" variant="outline" radius="compact">
        <CardHeader>
          <CardTitle>{t('deployment.runtime.runs.title')}</CardTitle>
          <CardDescription>{t('deployment.runtime.runs.count', { count: state.runs.length })}</CardDescription>
          <CardAction>
            <Button size="icon-sm" variant="ghost" aria-label={t('common.refresh')} onClick={() => void state.refreshWorkflow(workflow.id, true).catch(() => undefined)}>
              <RefreshCwIcon />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="min-h-0 p-0">
          <ScrollArea className="h-full max-h-[30rem] @min-[64rem]:max-h-none">
            <div className="flex flex-col gap-1 px-2 pb-2">
              {state.runs.map((run) => (
                <Button key={run.runId} variant={run.runId === state.selectedRunId ? 'secondary' : 'ghost'} className="h-auto min-w-0 justify-start py-2" onClick={() => void state.selectRun(run.runId).catch(() => undefined)}>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{run.targetRelease.releaseId}</span>
                    <span className="block text-xs text-muted-foreground">{formatDate(run.createdAt)}</span>
                  </span>
                  <Badge variant={statusBadgeVariant(run.status)}>{statusLabel(run.status, t)}</Badge>
                </Button>
              ))}
              {state.nextRunCursor && <Button variant="outline" size="sm" onClick={() => void state.loadMoreRuns().catch(() => undefined)} disabled={state.loadingMoreRuns}>{state.loadingMoreRuns && <Spinner data-icon="inline-start" />}{t('deployment.runtime.loadMore')}</Button>}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        {state.detail && (
          <>
            <RunStatusAlert
              status={state.detail.summary.status}
              evidenceGaps={state.nodes
                .filter((node) => node.status === 'state_unknown')
                .map((node) => workflow.definition.nodes.find((item) => item.id === node.nodeId)?.displayName ?? node.nodeType)}
              onReconcile={() => void state.reconcile().catch(() => undefined)}
            />
            <Card size="sm" variant="outline" radius="compact">
              <CardHeader>
                <CardTitle>{state.detail.summary.operationKind === 'rollback' ? t('deployment.runtime.operation.rollback') : t('deployment.runtime.operation.deploy')} · {state.detail.summary.targetRelease.releaseId}</CardTitle>
                <CardDescription>{formatDate(state.detail.summary.createdAt)} · {formatDuration(state.detail.summary.startedAt, state.detail.summary.finishedAt)}</CardDescription>
                <CardAction className="flex gap-1">
                  {state.detail.summary.status === 'awaiting_approval' && <Button size="sm" onClick={onOpenApproval}><ShieldCheckIcon data-icon="inline-start" />{t('deployment.runtime.reviewApproval')}</Button>}
                  {['approved', 'in_progress', 'verifying', 'reconciling'].includes(state.detail.summary.status) && <Button size="sm" variant="destructiveOutline" onClick={() => setCancelOpen(true)}><SquareIcon data-icon="inline-start" />{t('common.cancel')}</Button>}
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid gap-2 @min-[44rem]:grid-cols-3">
                  <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.plan')}</div><code className="text-xs">{shortDigest(state.detail.summary.planDigest)}</code></div>
                  <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.run.duration')}</div><div>{formatDuration(state.detail.summary.startedAt, state.detail.summary.finishedAt)}</div></div>
                  <div><div className="text-xs text-muted-foreground">{t('deployment.runtime.run.attempts')}</div><div>{state.nodes.reduce((sum, node) => sum + node.lastAttempt, 0)}</div></div>
                </div>
                <Separator />
                <div className="grid gap-3 @min-[48rem]:grid-cols-2 @min-[76rem]:grid-cols-3" aria-label={t('deployment.runtime.graph')}>
                  {orderedNodes.map((node) => {
                    const definitionNode = workflow.definition.nodes.find((item) => item.id === node.nodeId);
                    return (
                      <Card key={node.nodeId} size="sm" variant="outline" radius="compact">
                        <CardHeader>
                          <CardTitle>{definitionNode?.displayName ?? node.nodeType}</CardTitle>
                          <CardDescription>{formatDuration(node.startedAt, node.finishedAt)} · {t('deployment.runtime.attemptCount', { count: node.lastAttempt })}</CardDescription>
                          <CardAction><Badge variant={statusBadgeVariant(node.status)}>{statusLabel(node.status, t)}</Badge></CardAction>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2">
                          <NodeProgress node={node} />
                          <Button variant="outline" size="sm" onClick={() => void state.selectNode(node.nodeId).catch(() => undefined)}>{t('deployment.runtime.node.inspect')}</Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
            <div className="grid min-h-0 gap-3 @min-[58rem]:grid-cols-2">
              <Card size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{t('deployment.runtime.node.details')}</CardTitle>
                  <CardDescription>{workflow.definition.nodes.find((node) => node.id === selectedNode?.nodeId)?.displayName ?? t('deployment.runtime.node.none')}</CardDescription>
                  <CardAction><Button size="sm" variant="outline" onClick={onOpenEvidence} disabled={!selectedNode}><EyeIcon data-icon="inline-start" />{t('deployment.runtime.evidence.action')}</Button></CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <AttemptSelector attempts={state.attempts} selectedAttempt={selectedAttempt} onChange={setSelectedAttempt} />
                  {selectedNode && <NodeProgress node={selectedNode} />}
                  <div className="flex flex-col gap-1 font-mono text-xs" aria-label={t('deployment.runtime.logs')}>
                    {selectedEvents.map((event) => <div key={event.sequence}>#{event.sequence} · {eventLabel(event.summaryKey, t)}</div>)}
                    {selectedEvents.length === 0 && <span className="text-muted-foreground">{t('deployment.runtime.logs.empty')}</span>}
                  </div>
                  {selectedArtifact && <Button variant="outline" size="sm" onClick={() => void state.inspectArtifact(selectedArtifact).catch(() => undefined)}><FileArchiveIcon data-icon="inline-start" />{t('deployment.runtime.artifact.open')}</Button>}
                  {state.nextAttempt && <Button variant="ghost" size="sm" onClick={() => void state.loadMoreAttempts().catch(() => undefined)}>{t('deployment.runtime.attempt.loadMore')}</Button>}
                </CardContent>
              </Card>
              <Card className="min-h-0" size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{t('deployment.runtime.timeline')}</CardTitle>
                  <CardAction><Badge variant="secondary">{state.events.length}</Badge></CardAction>
                </CardHeader>
                <CardContent className="min-h-0 p-0">
                  <ScrollArea className="max-h-80">
                    <div className="flex flex-col gap-2 px-3 pb-3">
                      {state.events.map((event) => (
                        <div key={event.sequence} className="flex gap-2 text-sm">
                          <Badge variant="outline">#{event.sequence}</Badge>
                          <div className="min-w-0"><div className="truncate">{eventLabel(event.summaryKey, t)}</div><div className="text-xs text-muted-foreground">{formatDate(event.recordedAt)}</div></div>
                        </div>
                      ))}
                      {state.nextEventSequence && <Button variant="outline" size="sm" onClick={() => void state.loadMoreEvents().catch(() => undefined)}>{t('deployment.runtime.loadOlder')}</Button>}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deployment.runtime.cancel.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deployment.runtime.cancel.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void state.cancel().then(() => setCancelOpen(false)).catch(() => undefined)}>{t('deployment.runtime.cancel.action')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ReleaseCard({ release, onArtifact, onRollback }: {
  release: DeploymentReleaseRecord;
  onArtifact: (reference: DeploymentArtifactReference) => void;
  onRollback: (releaseId: string) => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <Card size="sm" variant="outline" radius="compact">
      <CardHeader>
        <CardTitle>{release.releaseId}</CardTitle>
        <CardDescription>{release.artifactType} · {formatDate(release.activatedAt)}</CardDescription>
        <CardAction><Badge variant={release.position === 'current' ? 'default' : 'secondary'}>{release.position === 'current' ? t('deployment.runtime.version.current') : t('deployment.runtime.version.previous')}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="break-all text-xs text-muted-foreground">{release.contentDigest}</code>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onArtifact(release.artifactReference)}><ArchiveIcon data-icon="inline-start" />{t('deployment.runtime.artifact.open')}</Button>
          {release.rollbackable && <Button size="sm" onClick={() => onRollback(release.releaseId)}><RotateCcwIcon data-icon="inline-start" />{t('deployment.runtime.rollback.action')}</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

function VersionsView({ workflow, onOpenApproval }: {
  workflow: DeploymentWorkflowRecord;
  onOpenApproval: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [rollbackOpen, setRollbackOpen] = React.useState(false);
  const [selectedReleaseId, setSelectedReleaseId] = React.useState('');
  const rollbackReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const rollbackable = state.releases.filter((release) => release.rollbackable);
  const options = rollbackable.map((release) => ({
    value: release.releaseId,
    label: `${release.releaseId} · ${shortDigest(release.contentDigest)}`,
  }));
  const openRollback = (releaseId: string): void => {
    rollbackReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedReleaseId(releaseId);
    setRollbackOpen(true);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="deployment-versions-view">
      <div className="grid gap-3 @min-[52rem]:grid-cols-2">
        {state.releases.map((release) => (
          <ReleaseCard
            key={release.position}
            release={release}
            onArtifact={(reference) => void state.inspectArtifact(reference).catch(() => undefined)}
            onRollback={openRollback}
          />
        ))}
      </div>
      {state.releases.length === 0 && <EmptyState icon={<RotateCcwIcon />} title={t('deployment.runtime.version.empty')} description={t('deployment.runtime.version.emptyDescription')} />}
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>{t('deployment.runtime.rollback.safetyTitle')}</AlertTitle>
        <AlertDescription>{t('deployment.runtime.rollback.safetyDescription')}</AlertDescription>
      </Alert>
      <Dialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        onOpenChangeComplete={(nextOpen) => { if (!nextOpen) rollbackReturnFocusRef.current?.focus(); }}
      >
        <DialogContent className="flex h-[min(30rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 p-4">
            <DialogTitle>{t('deployment.runtime.rollback.title')}</DialogTitle>
            <DialogDescription>{t('deployment.runtime.rollback.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="px-4 pb-4">
              <Field>
                <FieldLabel htmlFor="deployment-rollback-release">{t('deployment.runtime.rollback.release')}</FieldLabel>
                <Select items={options} value={selectedReleaseId} onValueChange={(value) => setSelectedReleaseId(value ?? '')}>
                  <SelectTrigger id="deployment-rollback-release" autoFocus><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <FieldDescription>{t('deployment.runtime.rollback.releaseDescription')}</FieldDescription>
              </Field>
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertTitle>{t('deployment.runtime.rollback.confirmTitle')}</AlertTitle>
                <AlertDescription>{t('deployment.runtime.rollback.confirmDescription')}</AlertDescription>
              </Alert>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 border-t p-4">
            <Button variant="outline" onClick={() => setRollbackOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={!selectedReleaseId || state.preparing}
              onClick={() => void state.prepare(workflow, selectedReleaseId).then(() => { setRollbackOpen(false); onOpenApproval(); }).catch(() => undefined)}
            >
              {state.preparing ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
              {t('deployment.runtime.rollback.prepare')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DeploymentWorkflowRuntimeView({ kind, workflow, semanticDirty = false }: {
  kind: RuntimeViewKind;
  workflow: DeploymentWorkflowRecord;
  semanticDirty?: boolean;
}): React.ReactNode {
  const [approvalOpen, setApprovalOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const approvalReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const evidenceReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const openApproval = (): void => {
    approvalReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setApprovalOpen(true);
  };
  const openEvidence = (): void => {
    evidenceReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEvidenceOpen(true);
  };
  return (
    <>
      {kind === 'prepare' && <PrepareView workflow={workflow} semanticDirty={semanticDirty} onOpenApproval={openApproval} />}
      {kind === 'runs' && <RunsView workflow={workflow} onOpenApproval={openApproval} onOpenEvidence={openEvidence} />}
      {kind === 'versions' && <VersionsView workflow={workflow} onOpenApproval={openApproval} />}
      <ApprovalDialog open={approvalOpen} onOpenChange={setApprovalOpen} workflow={workflow} returnFocusRef={approvalReturnFocusRef} />
      <EvidenceDialog open={evidenceOpen} onOpenChange={setEvidenceOpen} returnFocusRef={evidenceReturnFocusRef} />
    </>
  );
}

export function DeploymentWorkflowRuntimeOverlays(): React.ReactNode {
  return <ArtifactDrawer />;
}

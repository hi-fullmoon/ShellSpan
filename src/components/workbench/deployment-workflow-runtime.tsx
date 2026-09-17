import React from 'react';
import {
  AlertTriangleIcon,
  Clock3Icon,
  HistoryIcon,
  PackageCheckIcon,
  RefreshCwIcon,
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
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentRunStatus,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { ApprovalDialog } from './deployment/approval-dialog';
import { ArtifactDrawer } from './deployment/artifact-drawer';
import { EvidenceDialog } from './deployment/evidence-dialog';
import { ReleaseList } from './deployment/release-list';
import { RuntimeFlow } from './deployment/runtime-flow';
import { RuntimeNodeInspector } from './deployment/runtime-node-inspector';
import { RuntimeWorkspace } from './deployment/runtime-workspace';
import {
  deploymentStatusBadgeVariant,
  deploymentStatusLabel,
  formatDeploymentDate,
  formatDeploymentDuration,
  shortDeploymentDigest,
} from './deployment/runtime-utils';

type RuntimeViewKind = 'prepare' | 'runs' | 'versions';

const RunStatusAlert: React.FC<{
  status: DeploymentRunStatus;
  onReconcile: () => void;
  evidenceGaps?: readonly string[];
}> = ({ status, onReconcile, evidenceGaps = [] }) => {
  const { t } = useI18n();
  if (status === 'state_unknown') {
    return (
      <Alert variant="destructive" role="status">
        <AlertTriangleIcon />
        <AlertTitle>{t('deployment.runtime.unknown.title')}</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-1">
            <span>{t('deployment.runtime.unknown.description')}</span>
            {evidenceGaps.length > 0 && (
              <span>{t('deployment.runtime.unknown.gaps', { gaps: evidenceGaps.join(', ') })}</span>
            )}
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
        <AlertTitle>{deploymentStatusLabel(status, t)}</AlertTitle>
        <AlertDescription>{t('deployment.runtime.active.description')}</AlertDescription>
      </Alert>
    );
  }
  return null;
};

const PreparationProgress: React.FC = () => {
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
            <ProgressLabel>
              {nodes.find((node) => node.status === 'running')?.displayName
                ?? t('deployment.runtime.preparing.plan')}
            </ProgressLabel>
            <ProgressValue>{() => `${completed}/${total}`}</ProgressValue>
          </Progress>
          <div className="flex flex-wrap gap-1">
            {nodes.map((node) => (
              <Badge
                key={node.nodeId}
                variant={node.status === 'succeeded'
                  ? 'default'
                  : node.status === 'running'
                    ? 'secondary'
                    : node.status === 'failed'
                      ? 'destructive'
                      : 'outline'}
              >
                {node.displayName}
              </Badge>
            ))}
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
};

const PrepareView: React.FC<{
  workflow: DeploymentWorkflowRecord;
  semanticDirty: boolean;
  onOpenApproval: (trigger?: HTMLElement | null) => void;
}> = ({ workflow, semanticDirty, onOpenApproval }) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const awaiting = state.detail?.summary.status === 'awaiting_approval' ? state.detail : null;
  const blocking = awaiting?.summary.expired || awaiting?.summary.planDrifted;
  const requiredCapabilities = workflow.definition.nodes
    .filter((node) => node.type === 'target.preflight')
    .flatMap((node) => Array.isArray(node.config.requiredCapabilities)
      ? node.config.requiredCapabilities.map(String)
      : []);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col border"
      data-testid="deployment-prepare-view"
    >
      <header className="shrink-0 border-b px-3 py-2.5">
        <h2 className="text-sm font-medium">{t('deployment.runtime.prepare.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.description')}</p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
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
              <AlertTitle>{state.error.includes('CAPABILITY')
                ? t('deployment.runtime.capability.title')
                : t('deployment.runtime.prepareFailed.title')}</AlertTitle>
              <AlertDescription>{state.error.includes('CAPABILITY')
                ? t('deployment.runtime.capability.description')
                : t('deployment.runtime.prepareFailed.description')}</AlertDescription>
            </Alert>
          )}
          {awaiting && (
            <Alert variant={blocking ? 'warning' : 'default'} role="status">
              {blocking ? <AlertTriangleIcon /> : <ShieldCheckIcon />}
              <AlertTitle>{blocking
                ? t('deployment.runtime.approval.invalidTitle')
                : t('deployment.runtime.planReady.title')}</AlertTitle>
              <AlertDescription>{blocking
                ? t('deployment.runtime.approval.invalidDescription')
                : t('deployment.runtime.planReady.description', {
                  expires: formatDeploymentDate(awaiting.summary.expiresAt),
                })}</AlertDescription>
              <AlertAction>
                <Button
                  size="sm"
                  onClick={(event) => onOpenApproval(event.currentTarget)}
                  data-testid="deployment-open-approval"
                >
                  <ShieldCheckIcon data-icon="inline-start" />
                  {t('deployment.runtime.reviewApproval')}
                </Button>
              </AlertAction>
            </Alert>
          )}
          <dl className="grid gap-3 @min-[40rem]:grid-cols-3">
            <div className="border-b pb-2 @min-[40rem]:border-b-0 @min-[40rem]:border-r @min-[40rem]:pr-3">
              <dt className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.revision')}</dt>
              <dd className="mt-1 text-sm font-medium">{workflow.revision}</dd>
            </div>
            <div className="border-b pb-2 @min-[40rem]:border-b-0 @min-[40rem]:border-r @min-[40rem]:pr-3">
              <dt className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.nodes')}</dt>
              <dd className="mt-1 text-sm font-medium">{workflow.definition.nodes.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('deployment.runtime.prepare.retention')}</dt>
              <dd className="mt-1 text-sm font-medium">{workflow.definition.policy.releasesToKeep}</dd>
            </div>
          </dl>
          <section className="flex flex-col gap-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t('deployment.runtime.capability.required')}</h3>
              <Badge variant="secondary">{requiredCapabilities.length}</Badge>
            </div>
            <div className="flex flex-wrap gap-1">
              {requiredCapabilities.map((capability) => (
                <Badge key={capability} variant="outline">
                  {t(`deployment.editor.capability.${capability}` as LocaleKey)}
                </Badge>
              ))}
              {requiredCapabilities.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  {t('deployment.runtime.capability.none')}
                </span>
              )}
            </div>
          </section>
          {!workflow.enabled && (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>{t('deployment.runtime.workflowDisabled.title')}</AlertTitle>
              <AlertDescription>{t('deployment.runtime.workflowDisabled.description')}</AlertDescription>
            </Alert>
          )}
        </div>
      </ScrollArea>
      <footer className="flex shrink-0 justify-end border-t p-3">
        <Button
          size="sm"
          onClick={(event) => {
            const trigger = event.currentTarget;
            void state.prepare(workflow).then(() => onOpenApproval(trigger)).catch(() => undefined);
          }}
          disabled={semanticDirty || !workflow.enabled || state.preparing}
        >
          {state.preparing
            ? <Spinner data-icon="inline-start" />
            : <PackageCheckIcon data-icon="inline-start" />}
          {awaiting && blocking
            ? t('deployment.runtime.reprepare')
            : t('deployment.runtime.prepare.action')}
        </Button>
      </footer>
    </section>
  );
};

const RunListPane: React.FC<{ workflow: DeploymentWorkflowRecord }> = ({ workflow }) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t('deployment.runtime.runs.title')}
      data-testid="deployment-run-list"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{t('deployment.runtime.runs.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t('deployment.runtime.runs.count', { count: state.runs.length })}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.refresh')}
          onClick={() => void state.refreshWorkflow(workflow.id, true).catch(() => undefined)}
        >
          <RefreshCwIcon data-icon="inline-start" />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2 pb-2 pt-2">
          {state.runs.map((run) => (
            <Button
              key={run.runId}
              variant={run.runId === state.selectedRunId ? 'secondary' : 'ghost'}
              className="h-auto min-w-0 justify-start py-2"
              onClick={() => void state.selectRun(run.runId).catch(() => undefined)}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate">{run.targetRelease.releaseId}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDeploymentDate(run.createdAt)}
                </span>
              </span>
              <Badge variant={deploymentStatusBadgeVariant(run.status)}>
                {deploymentStatusLabel(run.status, t)}
              </Badge>
            </Button>
          ))}
          {state.nextRunCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void state.loadMoreRuns().catch(() => undefined)}
              disabled={state.loadingMoreRuns}
            >
              {state.loadingMoreRuns && <Spinner data-icon="inline-start" />}
              {t('deployment.runtime.loadMore')}
            </Button>
          )}
        </div>
      </ScrollArea>
    </section>
  );
};

const RunsView: React.FC<{
  workflow: DeploymentWorkflowRecord;
  catalog: DeploymentNodeTypeCatalog | null;
  onOpenApproval: (trigger?: HTMLElement | null) => void;
  onOpenEvidence: (trigger: HTMLElement) => void;
}> = ({ workflow, catalog, onOpenApproval, onOpenEvidence }) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const detail = state.detail;
  const active = detail
    && ['approved', 'in_progress', 'verifying', 'reconciling', 'cancel_requested']
      .includes(detail.summary.status);

  React.useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      void useDeploymentWorkflowRunStore.getState().refreshSelectedRun().catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [active]);

  if (state.loading && state.runs.length === 0) {
    return <PanelLoadingState label={t('deployment.runtime.loading')} />;
  }
  if (state.runs.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon />}
        title={t('deployment.runtime.runs.empty')}
        description={t('deployment.runtime.runs.emptyDescription')}
      />
    );
  }

  const summary = detail?.summary;
  const title = summary
    ? `${summary.operationKind === 'rollback'
      ? t('deployment.runtime.operation.rollback')
      : t('deployment.runtime.operation.deploy')} · ${summary.targetRelease.releaseId}`
    : t('deployment.runtime.runs.title');
  const description = summary
    ? `${formatDeploymentDate(summary.createdAt)} · ${formatDeploymentDuration(summary.startedAt, summary.finishedAt)} · ${shortDeploymentDigest(summary.planDigest)}`
    : t('deployment.runtime.runs.count', { count: state.runs.length });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="deployment-runs-view">
      {detail && (
        <RuntimeWorkspace
          title={title}
          description={description}
          actions={(
            <div className="flex shrink-0 items-center gap-1">
              {detail.summary.status === 'awaiting_approval' && (
                <Button
                  size="sm"
                  onClick={(event) => onOpenApproval(event.currentTarget)}
                  data-testid="deployment-open-approval"
                >
                  <ShieldCheckIcon data-icon="inline-start" />
                  <span className="hidden @min-[48rem]:inline">{t('deployment.runtime.reviewApproval')}</span>
                </Button>
              )}
              {['approved', 'in_progress', 'verifying', 'reconciling'].includes(detail.summary.status) && (
                <Button
                  size="sm"
                  variant="destructiveOutline"
                  onClick={() => setCancelOpen(true)}
                >
                  <SquareIcon data-icon="inline-start" />
                  <span className="hidden @min-[48rem]:inline">{t('common.cancel')}</span>
                </Button>
              )}
            </div>
          )}
          runPane={<RunListPane workflow={workflow} />}
          flow={(
            <div className="flex size-full min-h-0 flex-col">
              <div className="shrink-0 p-2">
                <RunStatusAlert
                  status={detail.summary.status}
                  evidenceGaps={state.nodes
                    .filter((node) => node.status === 'state_unknown')
                    .map((node) => workflow.definition.nodes.find(
                      (item) => item.id === node.nodeId,
                    )?.displayName ?? node.nodeType)}
                  onReconcile={() => void state.reconcile().catch(() => undefined)}
                />
              </div>
              <div className="min-h-0 flex-1">
                <RuntimeFlow
                  workflow={workflow}
                  catalog={catalog}
                  runNodes={state.nodes}
                  selectedNodeId={state.selectedNodeId}
                  onSelectNode={(nodeId) => void state.selectNode(nodeId).catch(() => undefined)}
                />
              </div>
            </div>
          )}
          inspector={<RuntimeNodeInspector workflow={workflow} onOpenEvidence={onOpenEvidence} />}
        />
      )}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deployment.runtime.cancel.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deployment.runtime.cancel.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void state.cancel()
                .then(() => setCancelOpen(false))
                .catch(() => undefined)}
            >
              {t('deployment.runtime.cancel.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export function DeploymentWorkflowRuntimeView({
  kind,
  workflow,
  catalog = null,
  semanticDirty = false,
}: {
  kind: RuntimeViewKind;
  workflow: DeploymentWorkflowRecord;
  catalog?: DeploymentNodeTypeCatalog | null;
  semanticDirty?: boolean;
}): React.ReactNode {
  const [approvalOpen, setApprovalOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const approvalReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const evidenceReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const openApproval = (trigger?: HTMLElement | null): void => {
    approvalReturnFocusRef.current = trigger
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setApprovalOpen(true);
  };
  const openEvidence = (trigger: HTMLElement): void => {
    evidenceReturnFocusRef.current = trigger;
    setEvidenceOpen(true);
  };

  return (
    <>
      {kind === 'prepare' && (
        <PrepareView
          workflow={workflow}
          semanticDirty={semanticDirty}
          onOpenApproval={openApproval}
        />
      )}
      {kind === 'runs' && (
        <RunsView
          workflow={workflow}
          catalog={catalog}
          onOpenApproval={openApproval}
          onOpenEvidence={openEvidence}
        />
      )}
      {kind === 'versions' && (
        <ReleaseList workflow={workflow} onOpenApproval={openApproval} />
      )}
      <ApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        workflow={workflow}
        returnFocusRef={approvalReturnFocusRef}
      />
      <EvidenceDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        returnFocusRef={evidenceReturnFocusRef}
      />
    </>
  );
}

export function DeploymentWorkflowRuntimeOverlays(): React.ReactNode {
  return <ArtifactDrawer />;
}

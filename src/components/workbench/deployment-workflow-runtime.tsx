import React from 'react';
import {
  AlertTriangleIcon,
  Clock3Icon,
  EyeIcon,
  HistoryIcon,
  MinusCircleIcon,
  PackageCheckIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SquareIcon,
  XCircleIcon,
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
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentRunDetail,
  DeploymentRunStatus,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { ApprovalDialog } from './deployment/approval-dialog';
import { ArtifactDrawer } from './deployment/artifact-drawer';
import { DeploymentPaneHeader } from './deployment/deployment-pane-header';
import { DeploymentDrawerContext } from './deployment/deployment-drawer';
import { EvidenceDialog } from './deployment/evidence-dialog';
import { ReleaseList } from './deployment/release-list';
import { RuntimeNodeInspector } from './deployment/runtime-node-inspector';
import { RuntimeStepList } from './deployment/runtime-step-list';
import { RuntimeWorkspace } from './deployment/runtime-workspace';
import {
  deploymentEventLabel,
  deploymentStatusBadgeVariant,
  deploymentStatusLabel,
  formatDeploymentDate,
  formatDeploymentDuration,
  shortDeploymentDigest,
} from './deployment/runtime-utils';

type RuntimeViewKind = 'runs' | 'versions';

export const RunStatusAlert: React.FC<{
  status: DeploymentRunStatus;
  onReconcile: () => void;
  onOpenEvidence?: (trigger: HTMLElement) => void;
  evidenceGaps?: readonly string[];
  failedNodes?: readonly string[];
  failureSummaryKey?: string | null;
  hasEvidence?: boolean;
  detail?: DeploymentRunDetail;
}> = ({ status, onReconcile, onOpenEvidence, evidenceGaps = [], failedNodes = [], failureSummaryKey = null, hasEvidence = false, detail }) => {
  const { t } = useI18n();
  if (status === 'state_unknown') {
    return (
      <Alert variant="destructive" role="status" className="has-data-[slot=alert-action]:grid-cols-[auto_minmax(0,1fr)_auto] has-data-[slot=alert-action]:pr-2.5">
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
        <AlertAction className="static col-start-3 row-span-2 row-start-1 self-start">
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
  if (status === 'failed' || status === 'canceled') {
    const failed = status === 'failed';
    return (
      <Alert
        variant="destructive"
        data-testid={failed ? 'deployment-run-failed-alert' : 'deployment-run-canceled-alert'}
        className="has-data-[slot=alert-action]:grid-cols-[auto_minmax(0,1fr)_auto] has-data-[slot=alert-action]:pr-2.5"
      >
        {failed ? <XCircleIcon /> : <MinusCircleIcon />}
        <AlertTitle>{t(failed ? 'deployment.runtime.failed.title' : 'deployment.runtime.canceled.title')}</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-1">
            <span>{t(failed ? 'deployment.runtime.failed.description' : 'deployment.runtime.canceled.description')}</span>
            {failed && detail?.receipts.some((receipt) => receipt.receiptType === 'compose.restore'
              && receipt.runId === detail.summary.runId
              && receipt.planDigest === detail.summary.planDigest) && (
              <span>{t('deployment.runtime.restore.receiptRecorded')}</span>
            )}
            {failedNodes.length > 0 && (
              <span>{t('deployment.runtime.failed.nodes', { nodes: failedNodes.join(', ') })}</span>
            )}
            {failureSummaryKey && <span>{deploymentEventLabel(failureSummaryKey, t)}</span>}
          </div>
        </AlertDescription>
        {hasEvidence && onOpenEvidence && (
          <AlertAction className="static col-start-3 row-span-2 row-start-1 self-start">
            <Button variant="outline" size="sm" onClick={(event) => onOpenEvidence(event.currentTarget)}>
              <EyeIcon data-icon="inline-start" />
              {t('deployment.runtime.evidence.action')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  }
  return null;
};

export const PreparationProgress: React.FC = () => {
  const { t } = useI18n();
  const nodes = useDeploymentWorkflowRunStore((state) => state.preparationNodes);
  const completed = useDeploymentWorkflowRunStore((state) => state.preparationCompleted);
  const total = useDeploymentWorkflowRunStore((state) => state.preparationTotal);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <Alert role="status" data-testid="deployment-preparing-progress">
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

const RunListPane: React.FC<{ workflow: DeploymentWorkflowRecord }> = ({ workflow }) => {
  const { t } = useI18n();
  const inDrawer = React.useContext(DeploymentDrawerContext);
  const state = useDeploymentWorkflowRunStore();
  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t('deployment.runtime.runs.title')}
      data-testid="deployment-run-list"
    >
      <DeploymentPaneHeader
        title={t('deployment.runtime.runs.title')}
        description={t('deployment.runtime.runs.count', { count: state.runs.length })}
        actions={(
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={state.loading || state.action !== null || state.preparing}
                />
              )}
              aria-label={t('common.refresh')}
              onClick={() => void state.refreshWorkflow(workflow.id, true).catch(() => undefined)}
            >
              <RefreshCwIcon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('common.refresh')}</TooltipContent>
          </Tooltip>
        )}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className={inDrawer ? 'flex flex-col gap-1 p-3' : 'flex flex-col gap-1 px-2 pb-2 pt-2'}>
          {state.runs.map((run) => (
            <Button
              key={run.runId}
              variant={run.runId === state.selectedRunId ? 'secondary' : 'ghost'}
              className="h-auto min-w-0 justify-start py-2"
              onClick={() => void state.selectRun(run.runId).catch(() => undefined)}
              disabled={state.loading || state.action !== null || state.preparing}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate">{run.targetRelease.releaseId}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDeploymentDate(run.createdAt)}
                </span>
              </span>
              <Badge size="sm" variant={deploymentStatusBadgeVariant(run.status)}>
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
  admissionsEnabled: boolean;
  onOpenApproval: (trigger?: HTMLElement | null) => void;
  onOpenEvidence: (trigger: HTMLElement) => void;
  onDeploy: () => void;
  onOpenDeploymentChecks?: (trigger: HTMLButtonElement) => void;
  canDeploy: boolean;
  approvalRequest: number;
  onApprovalHandled: () => void;
  deployTriggerRef: React.RefObject<HTMLButtonElement | null>;
}> = ({
  workflow,
  catalog,
  admissionsEnabled,
  onOpenApproval,
  onOpenEvidence,
  onDeploy,
  onOpenDeploymentChecks,
  canDeploy,
  approvalRequest,
  onApprovalHandled,
  deployTriggerRef,
}) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const handledApprovalRequestRef = React.useRef(0);
  const detail = state.detail;
  const readinessRequired = state.error?.includes('DEPLOYMENT_APPLICATION_READINESS_REQUIRED') === true;
  const managedFieldsChanged = state.error?.includes('DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED') === true;
  const revisionConflict = ['DEPLOYMENT_APPLICATION_REVISION_CONFLICT', 'DEPLOYMENT_WORKFLOW_REVISION_CONFLICT']
    .some((code) => state.error?.includes(code));
  const active = detail
    && ['awaiting_approval', 'approved', 'in_progress', 'verifying', 'reconciling', 'cancel_requested']
      .includes(detail.summary.status);

  React.useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      void useDeploymentWorkflowRunStore.getState().refreshSelectedRun().catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [active]);

  React.useEffect(() => {
    if (approvalRequest <= 0 || handledApprovalRequestRef.current === approvalRequest) return;
    if (state.detail?.summary.status === 'awaiting_approval') {
      handledApprovalRequestRef.current = approvalRequest;
      onApprovalHandled();
      onOpenApproval(deployTriggerRef.current);
    }
  }, [approvalRequest, state.detail, onApprovalHandled, onOpenApproval, deployTriggerRef]);

  if (state.preparing || (state.error && state.errorContext === 'prepare')) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="deployment-preparation-view">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-3 p-3">
            {state.preparing ? <PreparationProgress /> : (
              <Alert variant="destructive" data-testid="deployment-prepare-error">
                <AlertTriangleIcon />
                <AlertTitle>{t(revisionConflict
                  ? 'deployment.runtime.revisionConflict.title'
                  : managedFieldsChanged
                  ? 'deployment.runtime.managedFieldsChanged.title'
                  : readinessRequired
                  ? 'deployment.runtime.readinessRequired.title'
                  : state.error?.includes('CAPABILITY')
                  ? 'deployment.runtime.capability.title'
                  : 'deployment.runtime.prepareFailed.title')}</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap break-all">
                  <div className="flex flex-col items-start gap-2">
                  <p>{revisionConflict ? t('deployment.runtime.revisionConflict.description') : managedFieldsChanged ? t('deployment.runtime.managedFieldsChanged.description') : readinessRequired ? t('deployment.runtime.readinessRequired.description') : state.error}</p>
                  {(readinessRequired || managedFieldsChanged) && onOpenDeploymentChecks && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(event) => onOpenDeploymentChecks(event.currentTarget)}
                    >
                      {t(managedFieldsChanged ? 'deployment.application.configure' : 'deployment.runtime.readinessRequired.action')}
                    </Button>
                  )}
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  if (state.loading && state.runs.length === 0) {
    return <PanelLoadingState className="flex-1" label={t('deployment.runtime.loading')} />;
  }
  if (state.runs.length === 0) {
    return (
      <PanelEmptyState
        icon={<HistoryIcon />}
        title={t('deployment.runtime.runs.empty')}
        description={t('deployment.runtime.runs.emptyDescription')}
        action={(
          <Button onClick={onDeploy} disabled={!canDeploy || state.preparing} data-testid="deployment-run-empty-cta">
            <PackageCheckIcon data-icon="inline-start" />
            {t('deployment.runtime.deploy.action')}
          </Button>
        )}
      />
    );
  }

  const summary = detail?.summary ?? state.runs.find((run) => run.runId === state.selectedRunId);
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
      {(
        <RuntimeWorkspace
          title={title}
          description={description}
          actions={(
            <div className="flex shrink-0 items-center gap-1">
              {detail && ['awaiting_approval', 'approved'].includes(detail.summary.status) && (
                <Button
                  size="sm"
                  onClick={(event) => onOpenApproval(event.currentTarget)}
                  disabled={!admissionsEnabled || state.action !== null}
                  data-testid="deployment-open-approval"
                  aria-label={t(detail.summary.status === 'approved'
                    ? 'deployment.runtime.startApproved'
                    : 'deployment.runtime.reviewApproval')}
                >
                  <ShieldCheckIcon data-icon="inline-start" />
                  <span className="hidden @min-[48rem]:inline">
                    {t(detail.summary.status === 'approved'
                      ? 'deployment.runtime.startApproved'
                      : 'deployment.runtime.reviewApproval')}
                  </span>
                </Button>
              )}
              {detail && ['approved', 'in_progress', 'verifying', 'reconciling'].includes(detail.summary.status) && (
                <Button
                  size="sm"
                  variant="destructiveOutline"
                  onClick={() => setCancelOpen(true)}
                  disabled={state.action !== null}
                  aria-label={t('common.cancel')}
                >
                  <SquareIcon data-icon="inline-start" />
                  <span className="hidden @min-[48rem]:inline">{t('common.cancel')}</span>
                </Button>
              )}
            </div>
          )}
          runPane={<RunListPane workflow={workflow} />}
          flow={!detail ? (
            state.loading
              ? <PanelLoadingState label={t('deployment.runtime.loading')} />
              : null
          ) : (
            <div className="flex size-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-col gap-2 p-2 empty:hidden" data-testid="deployment-runtime-feedback">
                <RunStatusAlert
                  status={detail.summary.status}
                  detail={detail}
                  evidenceGaps={state.nodes
                    .filter((node) => node.status === 'state_unknown')
                    .map((node) => workflow.definition.nodes.find(
                      (item) => item.id === node.nodeId,
                    )?.displayName ?? node.nodeType)}
                  failedNodes={state.nodes
                    .filter((node) => node.status === 'failed')
                    .map((node) => workflow.definition.nodes.find(
                      (item) => item.id === node.nodeId,
                    )?.displayName ?? node.nodeType)}
                  failureSummaryKey={(() => {
                    const failedNodeIds = new Set(state.nodes
                      .filter((node) => node.status === 'failed')
                      .map((node) => node.nodeId));
                    return failedNodeIds.size > 0
                      ? [...state.events].reverse().find(
                        (event) => event.nodeId !== null && failedNodeIds.has(event.nodeId),
                      )?.summaryKey ?? null
                      : null;
                  })()}
                  hasEvidence={state.events.length > 0
                    || detail.receipts.length > 0
                    || state.nodes.some((node) => node.status === 'failed')}
                  onOpenEvidence={(trigger) => {
                    const failedNode = state.nodes.find((node) => node.status === 'failed');
                    if (failedNode && failedNode.nodeId !== state.selectedNodeId) {
                      void state.selectNode(failedNode.nodeId).catch(() => undefined);
                    }
                    onOpenEvidence(trigger);
                  }}
                  onReconcile={() => void state.reconcile().catch(() => undefined)}
                />
              </div>
              <div className="min-h-0 flex-1">
                <RuntimeStepList
                  workflow={workflow}
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
              disabled={state.action === 'cancel'}
              onClick={() => void state.cancel()
                .then(() => setCancelOpen(false))
                .catch(() => undefined)}
            >
              {state.action === 'cancel'
                ? <Spinner data-icon="inline-start" />
                : <SquareIcon data-icon="inline-start" />}
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
  admissionsEnabled = true,
  onDeploy,
  onOpenDeploymentChecks,
  canDeploy,
  approvalRequest = 0,
  onApprovalHandled,
  deployTriggerRef,
}: {
  kind: RuntimeViewKind;
  workflow: DeploymentWorkflowRecord;
  catalog?: DeploymentNodeTypeCatalog | null;
  admissionsEnabled?: boolean;
  onDeploy?: () => void;
  onOpenDeploymentChecks?: (trigger: HTMLButtonElement) => void;
  canDeploy?: boolean;
  approvalRequest?: number;
  onApprovalHandled?: () => void;
  deployTriggerRef?: React.RefObject<HTMLButtonElement | null>;
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
      {kind === 'runs' && (
        <RunsView
          workflow={workflow}
          catalog={catalog}
          admissionsEnabled={admissionsEnabled}
          onOpenApproval={openApproval}
          onOpenEvidence={openEvidence}
          onDeploy={onDeploy ?? (() => undefined)}
          onOpenDeploymentChecks={onOpenDeploymentChecks}
          canDeploy={canDeploy ?? false}
          approvalRequest={approvalRequest}
          onApprovalHandled={onApprovalHandled ?? (() => undefined)}
          deployTriggerRef={deployTriggerRef ?? { current: null }}
        />
      )}
      {kind === 'versions' && (
        <ReleaseList
          workflow={workflow}
          admissionsEnabled={admissionsEnabled}
          onOpenApproval={openApproval}
        />
      )}
      <ApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        workflow={workflow}
        admissionsEnabled={admissionsEnabled}
        returnFocusRef={approvalReturnFocusRef}
      />
      <EvidenceDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        workflow={workflow}
        returnFocusRef={evidenceReturnFocusRef}
      />
    </>
  );
}

export function DeploymentWorkflowRuntimeOverlays(): React.ReactNode {
  return <ArtifactDrawer />;
}

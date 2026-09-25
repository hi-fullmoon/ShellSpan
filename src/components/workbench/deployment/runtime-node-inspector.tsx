import React from 'react';
import { EyeIcon, FileArchiveIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type {
  DeploymentNodeAttemptRecord,
  DeploymentRunNodeRecord,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { DeploymentPaneHeader } from './deployment-pane-header';
import {
  deploymentEventLabel,
  deploymentNodeProgress,
  deploymentStatusLabel,
  formatDeploymentDate,
  formatDeploymentDuration,
} from './runtime-utils';

export const RuntimeNodeProgress: React.FC<{ node: DeploymentRunNodeRecord; nodeLabel?: string }> = ({ node, nodeLabel }) => {
  const { t } = useI18n();
  const progress = deploymentNodeProgress(node);
  return (
    <Progress value={progress.percent} aria-label={t('deployment.runtime.node.progress', { node: nodeLabel ?? node.nodeId })}>
      <ProgressLabel>{deploymentStatusLabel(node.status, t)}</ProgressLabel>
      <ProgressValue>{() => progress.valueLabel}</ProgressValue>
    </Progress>
  );
};

const AttemptSelector: React.FC<{
  attempts: readonly DeploymentNodeAttemptRecord[];
  selectedAttempt: number | null;
  onChange: (attempt: number) => void;
}> = ({ attempts, selectedAttempt, onChange }) => {
  const { t } = useI18n();
  const options = attempts.map((attempt) => ({
    value: String(attempt.attempt),
    label: `${t('deployment.runtime.attemptNumber', { attempt: attempt.attempt })} · ${deploymentStatusLabel(attempt.status, t)}`,
  }));
  if (options.length === 0) return null;
  return (
    <Select
      items={options}
      value={String(selectedAttempt ?? attempts[0].attempt)}
      onValueChange={(value) => { if (value) onChange(Number(value)); }}
    >
      <SelectTrigger size="sm" aria-label={t('deployment.runtime.attempt.select')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

export interface RuntimeNodeInspectorProps {
  workflow: DeploymentWorkflowRecord;
  onOpenEvidence: (trigger: HTMLElement) => void;
}

export const RuntimeNodeInspector: React.FC<RuntimeNodeInspectorProps> = ({
  workflow,
  onOpenEvidence,
}) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [attemptSelection, setAttemptSelection] = React.useState<{
    runId: string | null;
    nodeId: string | null;
    attempt: number;
  } | null>(null);
  const selectedNode = state.nodes.find((node) => node.nodeId === state.selectedNodeId) ?? null;
  const definitionNode = workflow.definition.nodes.find((node) => node.id === selectedNode?.nodeId);
  const selectedEvents = state.events.filter((event) => event.nodeId === state.selectedNodeId).slice(0, 6);
  const selectedOutputs = state.detail?.outputs.filter((output) => output.nodeId === state.selectedNodeId) ?? [];
  const selectedArtifact = selectedOutputs.find((output) => output.artifactReference)?.artifactReference;
  const selectedAttemptRecord = (attemptSelection?.runId === state.selectedRunId
    && attemptSelection?.nodeId === state.selectedNodeId
    ? state.attempts.find((attempt) => attempt.attempt === attemptSelection?.attempt)
    : undefined) ?? state.attempts[0] ?? null;
  const pendingAttempt = state.loadingAttempts && state.attempts.length === 0
    && (selectedNode?.lastAttempt ?? 0) > 0;

  return (
    <section
      className="flex size-full min-h-0 flex-col bg-background"
      data-testid="deployment-runtime-inspector"
      aria-label={t('deployment.runtime.node.details')}
    >
      <DeploymentPaneHeader
        title={t('deployment.runtime.node.details')}
        description={definitionNode?.displayName ?? t('deployment.runtime.node.none')}
        actions={(
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon-sm" variant="ghost" disabled={!selectedNode} />}
              onClick={(event) => onOpenEvidence(event.currentTarget)}
              aria-label={t('deployment.runtime.evidence.action')}
              data-testid="deployment-open-evidence"
            >
              <EyeIcon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('deployment.runtime.evidence.action')}</TooltipContent>
          </Tooltip>
        )}
      />
      {!selectedNode ? (
        <EmptyState
          className="min-h-0 flex-1"
          icon={<EyeIcon />}
          title={t('deployment.runtime.node.none')}
          description={t('deployment.runtime.evidence.emptyDescription')}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t('deployment.runtime.run.attempts')}
                </h3>
                <Badge variant="outline" size="sm">{selectedNode.lastAttempt}</Badge>
              </div>
              {pendingAttempt ? (
                <Skeleton className="h-8 w-full" aria-label={t('deployment.runtime.loading')} />
              ) : <AttemptSelector
                attempts={state.attempts}
                selectedAttempt={selectedAttemptRecord?.attempt ?? null}
                onChange={(attempt) => setAttemptSelection({
                  runId: state.selectedRunId, nodeId: state.selectedNodeId, attempt,
                })}
              />}
              {(selectedAttemptRecord || pendingAttempt) && (
                <dl
                  className="grid grid-cols-2 gap-2 text-xs"
                  data-testid="deployment-selected-attempt"
                  data-attempt={selectedAttemptRecord?.attempt}
                  aria-busy={pendingAttempt}
                >
                  <div>
                    <dt className="text-muted-foreground">{t('deployment.runtime.attempt.executor')}</dt>
                    <dd className="truncate">{selectedAttemptRecord?.executorVersion ?? <Skeleton className="h-4 w-full" />}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('deployment.runtime.run.duration')}</dt>
                    <dd>{selectedAttemptRecord ? formatDeploymentDuration(
                      selectedAttemptRecord.startedAt,
                      selectedAttemptRecord.finishedAt,
                    ) : <Skeleton className="h-4 w-full" />}</dd>
                  </div>
                  {selectedAttemptRecord?.failureCategory && (
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">{t('deployment.runtime.attempt.failure')}</dt>
                      <dd className="break-words">{selectedAttemptRecord.failureCategory}</dd>
                    </div>
                  )}
                </dl>
              )}
              <RuntimeNodeProgress
                node={selectedNode}
                nodeLabel={definitionNode?.displayName ?? selectedNode.nodeId}
              />
              {selectedArtifact && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void state.inspectArtifact(selectedArtifact).catch(() => undefined)}
                >
                  <FileArchiveIcon data-icon="inline-start" />
                  {t('deployment.runtime.artifact.open')}
                </Button>
              )}
              {state.nextAttempt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void state.loadMoreAttempts().catch(() => undefined)}
                >
                  {t('deployment.runtime.attempt.loadMore')}
                </Button>
              )}
            </section>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('deployment.runtime.logs')}
              </h3>
              <div className="flex flex-col gap-1 font-mono text-xs" aria-label={t('deployment.runtime.logs')}>
                {selectedEvents.map((event) => (
                  <div key={event.sequence}>#{event.sequence} · {deploymentEventLabel(event.summaryKey, t)}</div>
                ))}
                {selectedEvents.length === 0 && (
                  <span className="text-muted-foreground">{t('deployment.runtime.logs.empty')}</span>
                )}
              </div>
            </section>
            <Separator />
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t('deployment.runtime.timeline')}
                </h3>
                <Badge variant="secondary" size="sm">{state.events.length}</Badge>
              </div>
              {state.events.map((event) => (
                <div key={event.sequence} className="flex gap-2 text-sm">
                  <Badge variant="outline" size="sm">#{event.sequence}</Badge>
                  <div className="min-w-0">
                    <div className="truncate">{deploymentEventLabel(event.summaryKey, t)}</div>
                    <div className="text-xs text-muted-foreground">{formatDeploymentDate(event.recordedAt)}</div>
                  </div>
                </div>
              ))}
              {state.nextEventSequence && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void state.loadMoreEvents().catch(() => undefined)}
                >
                  {t('deployment.runtime.loadOlder')}
                </Button>
              )}
            </section>
          </div>
        </ScrollArea>
      )}
    </section>
  );
};

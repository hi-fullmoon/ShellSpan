import React from 'react';
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  Clock3Icon,
  HelpCircleIcon,
  MinusCircleIcon,
  RefreshCwIcon,
  XCircleIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { topologyOrder } from '@/lib/deployment/editor';
import type {
  DeploymentRunNodeRecord,
  DeploymentRunNodeStatus,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import {
  deploymentNodeProgress,
  deploymentStatusBadgeVariant,
  deploymentStatusLabel,
  formatDeploymentDuration,
} from './runtime-utils';

function stepStatusIcon(status: DeploymentRunNodeStatus): React.ReactNode {
  switch (status) {
    case 'running':
    case 'compensating':
      return <Spinner data-icon="inline-start" />;
    case 'retry_waiting':
    case 'cancel_requested':
      return <RefreshCwIcon data-icon="inline-start" />;
    case 'awaiting_approval':
      return <Clock3Icon data-icon="inline-start" />;
    case 'succeeded':
    case 'compensated':
      return <CheckCircle2Icon data-icon="inline-start" />;
    case 'failed':
      return <XCircleIcon data-icon="inline-start" />;
    case 'canceled':
    case 'skipped':
      return <MinusCircleIcon data-icon="inline-start" />;
    case 'state_unknown':
      return <HelpCircleIcon data-icon="inline-start" />;
    default:
      return <CircleDashedIcon data-icon="inline-start" />;
  }
}

export interface RuntimeStepListProps {
  workflow: DeploymentWorkflowRecord;
  runNodes: readonly DeploymentRunNodeRecord[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export const RuntimeStepList: React.FC<RuntimeStepListProps> = ({
  workflow,
  runNodes,
  selectedNodeId,
  onSelectNode,
}) => {
  const { t } = useI18n();
  const nodesById = new Map(runNodes.map((node) => [node.nodeId, node]));
  const definitionNodes = topologyOrder(workflow.definition).filter((node) => nodesById.has(node.id));
  const extraRunNodes = runNodes.filter((node) => !definitionNodes.some(
    (item) => item.id === node.nodeId,
  ));
  const rows: readonly { nodeId: string; displayName: string; node: DeploymentRunNodeRecord }[] = [
    ...definitionNodes.map((node) => ({
      nodeId: node.id,
      displayName: node.displayName,
      node: nodesById.get(node.id)!,
    })),
    ...extraRunNodes.map((node) => ({
      nodeId: node.nodeId,
      displayName: workflow.definition.nodes.find((item) => item.id === node.nodeId)?.displayName
        ?? node.nodeType,
      node,
    })),
  ];

  if (rows.length === 0) {
    return (
      <div
        className="flex size-full min-h-0 items-center justify-center"
        data-testid="deployment-runtime-step-list"
      >
        <EmptyState title={t('deployment.runtime.steps.empty')} />
      </div>
    );
  }

  return (
    <ScrollArea className="size-full" data-testid="deployment-runtime-step-list">
      <div className="flex flex-col pb-1">
        {rows.map((row, index) => {
          const selected = row.nodeId === selectedNodeId;
          const progress = deploymentNodeProgress(row.node);
          return (
            <React.Fragment key={row.nodeId}>
              {index > 0 && <Separator />}
              <div className="flex items-center gap-2 px-2 py-1">
                <Button
                  variant={selected ? 'secondary' : 'ghost'}
                  className="h-auto min-w-0 flex-1 items-start justify-start py-1.5"
                  aria-current={selected ? 'true' : undefined}
                  data-run-node-id={row.nodeId}
                  onClick={() => onSelectNode(row.nodeId)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {row.displayName}
                      </span>
                      <Badge variant={deploymentStatusBadgeVariant(row.node.status)} size="sm">
                        {stepStatusIcon(row.node.status)}
                        {deploymentStatusLabel(row.node.status, t)}
                      </Badge>
                    </span>
                    <span className="flex min-w-0 items-center gap-2 pl-7 text-xs text-muted-foreground">
                      <span>{formatDeploymentDuration(row.node.startedAt, row.node.finishedAt)}</span>
                      {(row.node.status === 'running' || row.node.status === 'compensating') && (
                        <span className="min-w-0 flex-1">
                          <Progress
                            value={progress.percent}
                            aria-label={t('deployment.runtime.node.progress', { node: row.displayName })}
                          />
                        </span>
                      )}
                    </span>
                  </span>
                </Button>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </ScrollArea>
  );
};

import React from 'react';
import { AlertTriangleIcon, LockKeyholeIcon } from 'lucide-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import {
  deploymentInputHandleId,
  deploymentOutputHandleId,
} from '@/lib/deployment/flow-connection';
import type { DeploymentFlowNodeData } from '@/lib/deployment/flow-projection';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';

function dynamicKey(value: string): LocaleKey {
  return value as LocaleKey;
}

function portPosition(index: number, count: number): string {
  return `${38 + ((index + 1) / (count + 1)) * 54}%`;
}

export type WorkflowCanvasNodeData = DeploymentFlowNodeData & {
  issueCount: number;
  readOnly: boolean;
};

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, 'deployment'>;

export interface DeploymentFlowNodeFrameProps {
  workflowNode: DeploymentFlowNodeData['workflowNode'];
  catalogNode: DeploymentFlowNodeData['catalogNode'];
  selected: boolean;
  dragging?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  badges: React.ReactNode;
  children: React.ReactNode;
}

export const DeploymentFlowNodeFrame: React.FC<DeploymentFlowNodeFrameProps> = ({
  workflowNode,
  catalogNode,
  selected,
  dragging = false,
  readOnly = false,
  invalid = false,
  badges,
  children,
}) => {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'relative w-60 rounded-md border bg-background px-2.5 py-2 text-foreground',
        invalid && 'border-destructive',
        selected && 'border-primary ring-2 ring-ring/30',
        readOnly && 'border-dashed',
        dragging && 'opacity-80',
      )}
      data-testid="deployment-flow-node"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{workflowNode.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {catalogNode ? t(dynamicKey(catalogNode.displayNameKey)) : workflowNode.type}
          </p>
        </div>
        <Badge variant="outline" size="sm">v{workflowNode.typeVersion}</Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">{badges}</div>
      {children}
    </div>
  );
};

export const WorkflowNode = React.memo<NodeProps<WorkflowCanvasNode>>(({
  data,
  selected,
  dragging,
  isConnectable,
}) => {
  const { t } = useI18n();
  const { workflowNode, catalogNode, inputPorts, outputPorts, issueCount, readOnly } = data;

  return (
    <DeploymentFlowNodeFrame
      workflowNode={workflowNode}
      catalogNode={catalogNode}
      selected={selected}
      dragging={dragging}
      readOnly={readOnly}
      invalid={issueCount > 0}
      badges={(
        <>
          {catalogNode && (
            <>
              <Badge variant="outline" size="sm">
                {t(dynamicKey(`deployment.editor.domain.${catalogNode.executionDomain}`))}
              </Badge>
              <Badge variant="outline" size="sm">
                {t(dynamicKey(`deployment.editor.effect.${catalogNode.effectClass}`))}
              </Badge>
              <Badge variant="outline" size="sm">
                {t(dynamicKey(`deployment.editor.risk.${catalogNode.riskLevel}`))}
              </Badge>
            </>
          )}
          {selected && <Badge size="sm">{t('deployment.editor.selected')}</Badge>}
          {issueCount > 0 && (
            <Badge variant="destructive" size="sm">
              <AlertTriangleIcon data-icon="inline-start" />
              {t('deployment.editor.flow.issueCount', { count: issueCount })}
            </Badge>
          )}
          {readOnly && (
            <Badge variant="secondary" size="sm">
              <LockKeyholeIcon data-icon="inline-start" />
              {t('deployment.editor.flow.readOnly')}
            </Badge>
          )}
        </>
      )}
    >
      <div className="mt-2 grid grid-cols-2 gap-3 border-t pt-1.5 text-xs">
        <div className="flex min-w-0 flex-col gap-1.5">
          {inputPorts.map((port, index) => {
            const label = t(dynamicKey(`deployment.editor.port.${port.name}`));
            const type = t(dynamicKey(`deployment.editor.portType.${port.portType}`));
            return (
              <div key={port.name} className="min-w-0" title={`${label} · ${type}`}>
                <Handle
                  id={deploymentInputHandleId(port.name)}
                  type="target"
                  position={Position.Left}
                  isConnectable={isConnectable}
                  isConnectableStart={false}
                  aria-label={t('deployment.editor.flow.inputHandle', {
                    node: workflowNode.displayName,
                    port: label,
                    type,
                  })}
                  className="size-3 border-2 border-background bg-muted-foreground"
                  style={{ top: portPosition(index, inputPorts.length) }}
                />
                <p className="truncate">← {label}</p>
                <p className="truncate text-[10px] text-muted-foreground">{type}</p>
              </div>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 text-right">
          {outputPorts.map((port, index) => {
            const label = t(dynamicKey(`deployment.editor.port.${port.name}`));
            const type = t(dynamicKey(`deployment.editor.portType.${port.portType}`));
            return (
              <div key={port.name} className="min-w-0" title={`${label} · ${type}`}>
                <Handle
                  id={deploymentOutputHandleId(port.name)}
                  type="source"
                  position={Position.Right}
                  isConnectable={isConnectable}
                  isConnectableEnd={false}
                  aria-label={t('deployment.editor.flow.outputHandle', {
                    node: workflowNode.displayName,
                    port: label,
                    type,
                  })}
                  className="size-3 border-2 border-background bg-muted-foreground"
                  style={{ top: portPosition(index, outputPorts.length) }}
                />
                <p className="truncate">{label} →</p>
                <p className="truncate text-[10px] text-muted-foreground">{type}</p>
              </div>
            );
          })}
        </div>
      </div>
    </DeploymentFlowNodeFrame>
  );
});

WorkflowNode.displayName = 'WorkflowNode';

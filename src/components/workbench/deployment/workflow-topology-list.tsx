import React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, ListTreeIcon, Settings2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import {
  projectDeploymentEdges,
  topologyOrder,
  type DeploymentEditorIssue,
} from '@/lib/deployment/editor';
import type { DeploymentNodeTypeCatalog } from '@/lib/deployment/types';
import type { DeploymentWorkflowDraft } from '@/stores/deploymentWorkflowStore';
import { deploymentLocaleKey, findDeploymentNodeSpec } from './deployment-editor-ui';
import { NodeInputFields } from './node-inspector';

export interface WorkflowTopologyListProps {
  draft: DeploymentWorkflowDraft;
  catalog: DeploymentNodeTypeCatalog;
  issues: readonly DeploymentEditorIssue[];
  editable?: boolean;
  onConfigure: (id: string, trigger: HTMLButtonElement) => void;
}

export const WorkflowTopologyList: React.FC<WorkflowTopologyListProps> = ({
  draft,
  catalog,
  issues,
  editable = true,
  onConfigure,
}) => {
  const { t } = useI18n();
  const nodes = topologyOrder(draft.definition);
  const edges = projectDeploymentEdges(draft.definition);

  if (nodes.length === 0) {
    return (
      <EmptyState
        icon={<ListTreeIcon />}
        title={t('deployment.editor.emptyGraph')}
        description={t('deployment.editor.emptyGraphDescription')}
      />
    );
  }

  return (
    <div className="flex flex-col" data-testid="deployment-topology-list">
      {nodes.map((workflowNode, index) => {
        const spec = findDeploymentNodeSpec(catalog, workflowNode);
        if (!spec) return null;
        const upstream = edges.filter((edge) => edge.targetNodeId === workflowNode.id).length;
        const downstream = edges.filter((edge) => edge.sourceNodeId === workflowNode.id).length;
        const nodeIssues = issues.filter((issue) => issue.nodeId === workflowNode.id);

        return (
          <React.Fragment key={workflowNode.id}>
            {index > 0 && <Separator />}
            <section
              className="flex flex-col gap-3 px-3 py-3"
              data-topology-node-id={workflowNode.id}
            >
              <header className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    <h3 className="truncate text-sm font-medium">{workflowNode.displayName}</h3>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('deployment.editor.topologyRelations', { upstream, downstream })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="outline" size="sm">
                      {t(deploymentLocaleKey(`deployment.editor.domain.${spec.executionDomain}`))}
                    </Badge>
                    {nodeIssues.length > 0 ? (
                      <Badge variant="destructive" size="sm">
                        <AlertTriangleIcon data-icon="inline-start" />
                        {t('deployment.editor.flow.issueCount', { count: nodeIssues.length })}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" size="sm">
                        <CheckCircle2Icon data-icon="inline-start" />
                        {t('deployment.editor.nodeReady')}
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => onConfigure(workflowNode.id, event.currentTarget)}
                >
                  <Settings2Icon data-icon="inline-start" />
                  {t('deployment.editor.configure')}
                </Button>
              </header>
              <NodeInputFields
                node={workflowNode}
                spec={spec}
                definition={draft.definition}
                catalog={catalog}
                editable={editable}
              />
            </section>
          </React.Fragment>
        );
      })}
    </div>
  );
};

import React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, ListTreeIcon, PlusIcon, Settings2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { projectDeploymentEdges, topologyOrder, type DeploymentEditorIssue } from '@/lib/deployment/editor';
import type { DeploymentNodeTypeCatalog } from '@/lib/deployment/types';
import type { DeploymentWorkflowDraft } from '@/stores/deploymentWorkflowStore';
import { deploymentLocaleKey, findDeploymentNodeSpec } from './deployment-editor-ui';

export interface WorkflowStepListProps {
  draft: DeploymentWorkflowDraft;
  catalog: DeploymentNodeTypeCatalog;
  issues: readonly DeploymentEditorIssue[];
  selectedNodeId: string | null;
  editable?: boolean;
  onSelectNode: (id: string) => void;
  onConfigure: (id: string, trigger: HTMLButtonElement) => void;
  onAddStep: (trigger: HTMLButtonElement) => void;
}

export const WorkflowStepList: React.FC<WorkflowStepListProps> = ({
  draft,
  catalog,
  issues,
  selectedNodeId,
  editable = true,
  onSelectNode,
  onConfigure,
  onAddStep,
}) => {
  const { t } = useI18n();
  const addStepRef = React.useRef<HTMLButtonElement>(null);
  const nodes = topologyOrder(draft.definition);
  const edges = projectDeploymentEdges(draft.definition);

  if (nodes.length === 0) {
    return (
      <section className="flex size-full min-h-0 flex-col bg-background" data-testid="deployment-step-list">
        <EmptyState
          className="min-h-0 flex-1"
          icon={<ListTreeIcon />}
          title={t('deployment.editor.stepList.empty')}
          description={t('deployment.editor.stepList.emptyDescription')}
          action={
            <Button
              ref={addStepRef}
              onClick={() => {
                const trigger = addStepRef.current;
                if (trigger) onAddStep(trigger);
              }}
              disabled={!editable}
            >
              <PlusIcon data-icon="inline-start" />
              {t('deployment.editor.stepList.addStep')}
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section
      className="flex size-full min-h-0 flex-col bg-background"
      data-testid="deployment-step-list"
      aria-label={t('deployment.editor.stepList.label')}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col pb-1">
          {nodes.map((workflowNode, index) => {
            const spec = findDeploymentNodeSpec(catalog, workflowNode);
            if (!spec) return null;
            const upstream = edges.filter((edge) => edge.targetNodeId === workflowNode.id).length;
            const downstream = edges.filter((edge) => edge.sourceNodeId === workflowNode.id).length;
            const nodeIssues = issues.filter((issue) => issue.nodeId === workflowNode.id);
            const selected = workflowNode.id === selectedNodeId;

            return (
              <React.Fragment key={workflowNode.id}>
                {index > 0 && <Separator />}
                <div className={cn('flex items-center gap-2 px-2 py-1')} data-step-node-id={workflowNode.id}>
                  <Button
                    variant={selected ? 'secondary' : 'ghost'}
                    className="h-auto min-w-0 flex-1 justify-start py-1.5"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelectNode(workflowNode.id)}
                    aria-label={t('deployment.editor.stepList.stepAria', {
                      index: index + 1,
                      name: workflowNode.displayName,
                    })}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{workflowNode.displayName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t('deployment.editor.stepList.relations', { upstream, downstream })}
                        </span>
                      </span>
                    </span>
                    <Badge variant="outline" size="sm">
                      {t(deploymentLocaleKey(`deployment.editor.domain.${spec.executionDomain}`))}
                    </Badge>
                    {nodeIssues.length > 0 ? (
                      <Badge variant="destructive" size="sm">
                        <AlertTriangleIcon data-icon="inline-start" />
                        {t('deployment.editor.stepList.issueCount', { count: nodeIssues.length })}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" size="sm">
                        <CheckCircle2Icon data-icon="inline-start" />
                        {t('deployment.editor.nodeReady')}
                      </Badge>
                    )}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={(event) => onConfigure(workflowNode.id, event.currentTarget)}
                    aria-label={t('deployment.editor.configure')}
                  >
                    <Settings2Icon data-icon="inline-start" />
                  </Button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </ScrollArea>
      <footer className="flex shrink-0 justify-center border-t p-2">
        <Button
          ref={addStepRef}
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            const trigger = addStepRef.current;
            if (trigger) onAddStep(trigger);
          }}
          disabled={!editable}
        >
          <PlusIcon data-icon="inline-start" />
          {t('deployment.editor.stepList.addStep')}
        </Button>
      </footer>
    </section>
  );
};

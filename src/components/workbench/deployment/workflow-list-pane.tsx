import React from 'react';
import { PlusIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { DeploymentPaneHeader } from './deployment-pane-header';
import { WorkbenchSearchInput } from '../workbench-page';
import { DeploymentDrawerContext } from './deployment-drawer';

export interface WorkflowListPaneProps {
  workflows: readonly DeploymentWorkflowRecord[];
  draftName?: string | null;
  selectedWorkflowId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  canCreate?: boolean;
  selectionDisabled?: boolean;
  showHeader?: boolean;
}

export const WorkflowListPane: React.FC<WorkflowListPaneProps> = ({
  workflows,
  draftName = null,
  selectedWorkflowId,
  search,
  onSearchChange,
  onSelect,
  onCreate,
  canCreate = true,
  selectionDisabled = false,
  showHeader = true,
}) => {
  const { t } = useI18n();
  const inDrawer = React.useContext(DeploymentDrawerContext);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visible = workflows.filter((workflow) => (
    workflow.name.toLocaleLowerCase().includes(normalizedSearch)
  ));
  const draftVisible = Boolean(
    draftName?.toLocaleLowerCase().includes(normalizedSearch),
  );
  const workflowCount = workflows.length + (draftName ? 1 : 0);

  return (
    <section
      className="flex size-full min-h-0 min-w-0 flex-col bg-background"
      data-testid="deployment-workflow-list"
      aria-label={t('deployment.editor.workflows')}
    >
      {showHeader && (
        <DeploymentPaneHeader
          title={t('deployment.editor.workflows')}
          description={t('deployment.editor.workflowCount', { count: workflowCount })}
          actions={(
            <Tooltip>
              <TooltipTrigger
                render={<Button size="icon-sm" variant="ghost" disabled={!canCreate} />}
                onClick={onCreate}
                aria-label={t('deployment.editor.template.title')}
              >
                <PlusIcon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{t('deployment.editor.template.title')}</TooltipContent>
            </Tooltip>
          )}
        />
      )}
      <div className={inDrawer ? 'shrink-0 px-3 py-2' : 'shrink-0 p-2'}>
        <WorkbenchSearchInput
          containerClassName="min-w-0 w-full flex-1"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('deployment.editor.search')}
          aria-label={t('deployment.editor.search')}
          onClear={() => onSearchChange('')}
          clearLabel={t('common.clear')}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={inDrawer ? 'flex flex-col gap-1 px-3 pb-3' : 'flex flex-col gap-1 px-2 pb-2'}>
          {draftVisible && draftName && (
            <Button
              variant="secondary"
              className="h-auto min-w-0 justify-start py-2.5 disabled:opacity-100"
              disabled
              aria-current="page"
            >
              <span className="min-w-0 flex-1 truncate text-left">{draftName}</span>
              <Badge variant="secondary" size="sm">
                {t('deployment.editor.unsaved')}
              </Badge>
            </Button>
          )}
          {visible.map((workflow) => (
            <Button
              key={workflow.id}
              variant={workflow.id === selectedWorkflowId ? 'secondary' : 'ghost'}
              className="h-auto min-w-0 justify-start py-2.5"
              onClick={() => onSelect(workflow.id)}
              disabled={selectionDisabled}
            >
              <span className="min-w-0 flex-1 truncate text-left">{workflow.name}</span>
              <Badge variant="outline" size="sm">
                {t('deployment.editor.revision', { revision: workflow.revision })}
              </Badge>
            </Button>
          ))}
          {!draftVisible && visible.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('deployment.editor.noSearchResults')}
            </p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
};

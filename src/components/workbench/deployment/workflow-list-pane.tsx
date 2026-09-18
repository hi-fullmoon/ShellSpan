import React from 'react';
import { PlusIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { WorkbenchSearchInput } from '../workbench-page';

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
        <header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{t('deployment.editor.workflows')}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {t('deployment.editor.workflowCount', { count: workflowCount })}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onCreate}
            disabled={!canCreate}
            aria-label={t('deployment.editor.template.title')}
          >
            <PlusIcon data-icon="inline-start" />
          </Button>
        </header>
      )}
      <div className="shrink-0 p-2">
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
        <div className="flex flex-col gap-1 px-2 pb-2">
          {draftVisible && draftName && (
            <Button
              variant="secondary"
              className="h-auto min-w-0 justify-start py-1.5 disabled:opacity-100"
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
              className="h-auto min-w-0 justify-start py-1.5"
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

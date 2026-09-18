import React from 'react';
import {
  CheckCircle2Icon,
  ListTreeIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';

export type DeploymentWorkflowTab = 'design' | 'prepare' | 'runs' | 'versions';

export interface DeploymentWorkflowTabsProps {
  activeTab: DeploymentWorkflowTab;
  loading: boolean;
  saving: boolean;
  validating: boolean;
  canCreate: boolean;
  canSave: boolean;
  onOpenWorkflows: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onSave: () => void;
  onValidate: () => void;
  workflowsTriggerRef?: React.Ref<HTMLButtonElement>;
}

const ActionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="hidden @min-[72rem]:inline">{children}</span>
);

export const DeploymentWorkflowTabs: React.FC<DeploymentWorkflowTabsProps> = ({
  activeTab,
  loading,
  saving,
  validating,
  canCreate,
  canSave,
  onOpenWorkflows,
  onRefresh,
  onCreate,
  onSave,
  onValidate,
  workflowsTriggerRef,
}) => {
  const { t } = useI18n();
  return (
    <div
      className="flex min-h-10 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b px-3 py-1"
      data-testid="deployment-workflow-toolbar"
    >
      <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <TabsList variant="line" className="min-w-max justify-start">
          <TabsTrigger value="design">{t('deployment.editor.tab.design')}</TabsTrigger>
          <TabsTrigger value="prepare">{t('deployment.editor.tab.prepare')}</TabsTrigger>
          <TabsTrigger value="runs">{t('deployment.editor.tab.runs')}</TabsTrigger>
          <TabsTrigger value="versions">{t('deployment.editor.tab.versions')}</TabsTrigger>
        </TabsList>
      </div>
      <div
        className="flex shrink-0 flex-nowrap items-center gap-1"
        data-testid="deployment-workflow-actions"
      >
        <Button
          ref={workflowsTriggerRef}
          variant="outline"
          size="sm"
          className={activeTab === 'design' ? '@min-[72rem]:hidden' : undefined}
          onClick={onOpenWorkflows}
          aria-label={t('deployment.editor.workflows')}
          title={t('deployment.editor.workflows')}
        >
          <ListTreeIcon data-icon="inline-start" />
          <span className="sr-only">{t('deployment.editor.workflows')}</span>
        </Button>
        {activeTab === 'design' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onValidate}
            disabled={validating || saving}
            aria-label={t('deployment.editor.validate')}
            title={t('deployment.editor.validate')}
          >
            {validating
              ? <Spinner data-icon="inline-start" />
              : <CheckCircle2Icon data-icon="inline-start" />}
            <ActionLabel>{t('deployment.editor.validate')}</ActionLabel>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading || saving}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
        >
          {loading
            ? <Spinner data-icon="inline-start" />
            : <RefreshCwIcon data-icon="inline-start" />}
          <ActionLabel>{t('common.refresh')}</ActionLabel>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCreate}
          disabled={!canCreate}
          aria-label={t('deployment.editor.newWorkflow')}
          title={t('deployment.editor.newWorkflow')}
        >
          <PlusIcon data-icon="inline-start" />
          <ActionLabel>{t('deployment.editor.newWorkflow')}</ActionLabel>
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canSave || saving}
          aria-label={t('common.save')}
          title={t('common.save')}
        >
          {saving
            ? <Spinner data-icon="inline-start" />
            : <SaveIcon data-icon="inline-start" />}
          <ActionLabel>{t('common.save')}</ActionLabel>
        </Button>
      </div>
    </div>
  );
};

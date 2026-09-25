import React from 'react';
import { CheckCircle2Icon, ListTreeIcon, PlusIcon, RefreshCwIcon, RocketIcon, SaveIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkflowTab } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useToastStore } from '@/stores/toastStore';
import { getErrorMessage } from '@/lib/error';
import { deploymentStatusLabel } from './runtime-utils';

export interface DeploymentWorkflowTabsProps {
  activeTab: DeploymentWorkflowTab;
  loading: boolean;
  saving: boolean;
  validating: boolean;
  preparing: boolean;
  canCreate: boolean;
  canSave: boolean;
  canDeploy: boolean;
  deployHint: string | null;
  onOpenWorkflows: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onSave: () => void;
  onValidate: () => void;
  onDeploy: () => void;
  deployTriggerRef?: React.Ref<HTMLButtonElement>;
  workflowsTriggerRef?: React.Ref<HTMLButtonElement>;
}

// Icon-only buttons must stay square: the workflows trigger is always
// icon-only, and the labelled actions collapse to icons below 72rem.
const squareWhenIconOnly = '@max-[72rem]:size-8';

// Triggers stretch to the toolbar's bottom divider and the active underline
// rides flush on it: -1px clears the trigger's transparent bottom border while
// staying inside the horizontal scroller's clip edge (overflow-y-hidden).
const tabTriggerClass = 'h-full! px-2.5 after:-bottom-px!';

const ActionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="hidden @min-[72rem]:inline">{children}</span>;

export const DeploymentWorkflowTabs: React.FC<DeploymentWorkflowTabsProps> = ({
  activeTab,
  loading,
  saving,
  validating,
  preparing,
  canCreate,
  canSave,
  canDeploy,
  deployHint,
  onOpenWorkflows,
  onRefresh,
  onCreate,
  onSave,
  onValidate,
  onDeploy,
  deployTriggerRef,
  workflowsTriggerRef,
}) => {
  const { t } = useI18n();
  const preparationRunId = useDeploymentWorkflowRunStore((state) => state.preparationRunId);
  const [cancelPending, setCancelPending] = React.useState(false);
  const [cancelRequested, setCancelRequested] = React.useState(false);
  React.useEffect(() => {
    setCancelPending(false);
    setCancelRequested(false);
  }, [preparing]);
  const cancelLabel = cancelRequested ? deploymentStatusLabel('cancel_requested', t) : t('deployment.runtime.cancel.action');
  return (
    <div className="flex min-h-10 shrink-0 flex-nowrap items-center gap-3 overflow-hidden border-b pr-3" data-testid="deployment-workflow-toolbar">
      <div className="min-w-0 flex-1 self-stretch overflow-x-auto overflow-y-hidden">
        <TabsList variant="line" className="h-full! min-w-max justify-start p-0">
          <TabsTrigger value="pipeline" className={tabTriggerClass}>
            {t('deployment.editor.tab.pipeline')}
          </TabsTrigger>
          <TabsTrigger value="runs" className={tabTriggerClass}>
            {t('deployment.editor.tab.runs')}
          </TabsTrigger>
          <TabsTrigger value="versions" className={tabTriggerClass}>
            {t('deployment.editor.tab.versions')}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="flex shrink-0 flex-nowrap items-center gap-1" data-testid="deployment-workflow-actions">
        <Button
          ref={workflowsTriggerRef}
          variant="outline"
          size="sm"
          className={activeTab === 'pipeline' ? 'size-8 @min-[72rem]:hidden' : 'size-8'}
          onClick={onOpenWorkflows}
          aria-label={t('deployment.editor.workflows')}
        >
          <ListTreeIcon data-icon="inline-start" />
          <span className="sr-only">{t('deployment.editor.workflows')}</span>
        </Button>
        {activeTab === 'pipeline' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onValidate}
            disabled={validating || saving}
            className={squareWhenIconOnly}
            aria-label={t('deployment.editor.validate')}
          >
            {validating ? <Spinner data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
            <ActionLabel>{t('deployment.editor.validate')}</ActionLabel>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading || saving}
          className={squareWhenIconOnly}
          aria-label={t('common.refresh')}
        >
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          <ActionLabel>{t('common.refresh')}</ActionLabel>
        </Button>
        {activeTab === 'pipeline' && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreate}
              disabled={!canCreate}
              className={squareWhenIconOnly}
              aria-label={t('deployment.editor.newWorkflow')}
            >
              <PlusIcon data-icon="inline-start" />
              <ActionLabel>{t('deployment.editor.newWorkflow')}</ActionLabel>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onSave}
              disabled={!canSave || saving}
              className={squareWhenIconOnly}
              aria-label={t('common.save')}
            >
              {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              <ActionLabel>{t('common.save')}</ActionLabel>
            </Button>
          </>
        )}
        {preparing && <Button
          variant="outline"
          size="sm"
          className={squareWhenIconOnly}
          aria-label={cancelLabel}
          disabled={!preparationRunId || cancelPending || cancelRequested}
          onClick={() => {
            setCancelPending(true);
            void useDeploymentWorkflowRunStore.getState().cancelPreparation()
              .then(() => setCancelRequested(true))
              .catch((error: unknown) => useToastStore.getState().addToast(getErrorMessage(error), 'error'))
              .finally(() => setCancelPending(false));
          }}
        >
          {cancelPending ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
          <ActionLabel>{cancelLabel}</ActionLabel>
        </Button>}
        <Button
          ref={deployTriggerRef}
          size="sm"
          className={squareWhenIconOnly}
          onClick={onDeploy}
          disabled={!canDeploy || preparing}
          aria-label={t('deployment.runtime.deploy.action')}
          aria-description={deployHint ?? undefined}
          data-testid="deployment-deploy-action"
        >
          {preparing ? <Spinner data-icon="inline-start" /> : <RocketIcon data-icon="inline-start" />}
          <ActionLabel>{t('deployment.runtime.deploy.action')}</ActionLabel>
        </Button>
      </div>
    </div>
  );
};

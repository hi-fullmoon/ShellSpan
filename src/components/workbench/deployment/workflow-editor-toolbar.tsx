import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  PanelRightIcon,
  Settings2Icon,
  Trash2Icon,
} from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import type { DeploymentWorkspaceLayout } from './deployment-workspace-shell';
import { DeploymentPaneHeader } from './deployment-pane-header';

export interface WorkflowEditorToolbarProps {
  workflowId: string | null;
  workflowName: string;
  layout: DeploymentWorkspaceLayout;
  enabled: boolean;
  editable: boolean;
  issueCount: number;
  dirty: boolean;
  onOpenIssues: () => void;
  onOpenInspector: () => void;
  onOpenSettings: () => void;
  inspectorTriggerRef?: React.Ref<HTMLButtonElement>;
  settingsTriggerRef?: React.Ref<HTMLButtonElement>;
}

export const WorkflowEditorToolbar: React.FC<WorkflowEditorToolbarProps> = ({
  workflowId,
  workflowName,
  layout,
  enabled,
  editable,
  issueCount,
  dirty,
  onOpenIssues,
  onOpenInspector,
  onOpenSettings,
  inspectorTriggerRef,
  settingsTriggerRef,
}) => {
  const { t } = useI18n();
  const saving = useDeploymentWorkflowStore((state) => state.saving);
  const archiveWorkflow = useDeploymentWorkflowStore((state) => state.archiveWorkflow);
  const preparing = useDeploymentWorkflowRunStore((state) => state.preparing);
  const runAction = useDeploymentWorkflowRunStore((state) => state.action);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [archivePending, setArchivePending] = React.useState(false);
  // Dirty drafts are handled by the confirm dialog, which discloses that the
  // unsaved changes are discarded; only an in-flight operation blocks deletion.
  const deleteDisabled = saving || preparing || runAction !== null;

  const confirmDelete = async (): Promise<void> => {
    if (!workflowId || archivePending) return;
    setArchivePending(true);
    if (dirty) {
      // The dialog above already disclosed discarding the draft; clear the
      // flags so the store guard sees an explicit UI decision, not data loss.
      useDeploymentWorkflowStore.setState({ semanticDirty: false, layoutDirty: false });
    }
    await archiveWorkflow(workflowId);
    setArchivePending(false);
    setDeleteOpen(false);
  };

  const header = (
    <DeploymentPaneHeader
      data-testid="deployment-editor-toolbar"
      title={workflowName}
      titleMeta={(
        <>
          <Badge variant={enabled ? 'secondary' : 'outline'} size="sm">
            {t(enabled ? 'deployment.editor.enabled' : 'deployment.editor.disabled')}
          </Badge>
          <Badge
            variant={issueCount > 0 ? 'destructive' : 'outline'}
            size="sm"
            render={(
              <button
                type="button"
                onClick={onOpenIssues}
                data-testid="deployment-validation-status"
              />
            )}
          >
            {issueCount > 0
              ? <AlertTriangleIcon data-icon="inline-start" />
              : <CheckCircle2Icon data-icon="inline-start" />}
            {issueCount > 0
              ? t('deployment.editor.issues', { count: issueCount })
              : t('deployment.editor.status.validated')}
          </Badge>
          {dirty && (
            <Badge variant="secondary" size="sm">
              {t('deployment.editor.status.unsaved')}
            </Badge>
          )}
        </>
      )}
      description={t('deployment.editor.stepList.description')}
      actions={(
        <>
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon-sm" variant="ghost" disabled={!editable} />}
              ref={settingsTriggerRef}
              onClick={onOpenSettings}
              aria-label={t('deployment.editor.settings')}
            >
              <Settings2Icon data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent>{t('deployment.editor.settings')}</TooltipContent>
          </Tooltip>
          {layout !== 'wide' && (
            <Tooltip>
              <TooltipTrigger
                render={<Button size="icon-sm" variant="ghost" />}
                ref={inspectorTriggerRef}
                onClick={onOpenInspector}
                aria-label={t('deployment.editor.configuration')}
              >
                <PanelRightIcon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{t('deployment.editor.configuration')}</TooltipContent>
            </Tooltip>
          )}
          {workflowId && (
            <Tooltip>
              <TooltipTrigger
                render={<Button size="icon-sm" variant="ghost" disabled={deleteDisabled} />}
                onClick={() => setDeleteOpen(true)}
                aria-label={t('deployment.editor.delete.title')}
                data-testid="deployment-delete-workflow"
              >
                <Trash2Icon data-icon="inline-start" />
              </TooltipTrigger>
              <TooltipContent>{t('deployment.editor.delete.title')}</TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    />
  );

  return (
    <>
      {header}
      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!archivePending) setDeleteOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deployment.editor.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(dirty
                ? 'deployment.editor.delete.dirtyDescription'
                : 'deployment.editor.delete.description', { name: workflowName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archivePending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              disabled={archivePending}
            >
              {archivePending && <Spinner data-icon="inline-start" />}
              {t('deployment.editor.delete.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  LibraryIcon,
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
  onOpenLibrary: () => void;
  onOpenInspector: () => void;
  onOpenSettings: () => void;
  libraryTriggerRef?: React.Ref<HTMLButtonElement>;
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
  onOpenLibrary,
  onOpenInspector,
  onOpenSettings,
  libraryTriggerRef,
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
                title={t('deployment.editor.validation.title')}
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
          <Button
            ref={libraryTriggerRef}
            size="icon-sm"
            variant="outline"
            onClick={onOpenLibrary}
            disabled={!editable}
            aria-label={t('deployment.editor.nodeLibrary')}
            title={t('deployment.editor.nodeLibrary')}
          >
            <LibraryIcon data-icon="inline-start" />
          </Button>
          <Button
            ref={settingsTriggerRef}
            size="icon-sm"
            variant="outline"
            onClick={onOpenSettings}
            disabled={!editable}
            aria-label={t('deployment.editor.settings')}
            title={t('deployment.editor.settings')}
          >
            <Settings2Icon data-icon="inline-start" />
          </Button>
          {layout !== 'wide' && (
            <Button
              ref={inspectorTriggerRef}
              size="icon-sm"
              variant="outline"
              onClick={onOpenInspector}
              aria-label={t('deployment.editor.configuration')}
              title={t('deployment.editor.configuration')}
            >
              <PanelRightIcon data-icon="inline-start" />
            </Button>
          )}
          {workflowId && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteDisabled}
              aria-label={t('deployment.editor.delete.title')}
              title={t('deployment.editor.delete.title')}
              data-testid="deployment-delete-workflow"
            >
              <Trash2Icon data-icon="inline-start" />
            </Button>
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

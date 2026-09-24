import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  LibraryIcon,
  PanelRightIcon,
  Settings2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkspaceLayout } from './deployment-workspace-shell';
import { DeploymentPaneHeader } from './deployment-pane-header';

export interface WorkflowEditorToolbarProps {
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
  return (
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
        </>
      )}
    />
  );
};

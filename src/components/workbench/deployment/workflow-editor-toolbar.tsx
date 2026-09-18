import React from 'react';
import { LibraryIcon, PanelRightIcon, Settings2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkspaceLayout } from './deployment-workspace-shell';

export interface WorkflowEditorToolbarProps {
  workflowName: string;
  layout: DeploymentWorkspaceLayout;
  enabled: boolean;
  editable: boolean;
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
  onOpenLibrary,
  onOpenInspector,
  onOpenSettings,
  libraryTriggerRef,
  inspectorTriggerRef,
  settingsTriggerRef,
}) => {
  const { t } = useI18n();
  return (
    <header
      className="flex min-h-11 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b px-3 py-1.5"
      data-testid="deployment-editor-toolbar"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-medium">{workflowName}</h2>
          <Badge variant={enabled ? 'secondary' : 'outline'} size="sm">
            {t(enabled ? 'deployment.editor.enabled' : 'deployment.editor.disabled')}
          </Badge>
        </div>
        <p className="hidden truncate text-xs text-muted-foreground @min-[60rem]:block">
          {t('deployment.editor.canvasDescription')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
      </div>
    </header>
  );
};

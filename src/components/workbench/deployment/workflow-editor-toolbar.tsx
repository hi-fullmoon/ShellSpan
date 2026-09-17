import React from 'react';
import { LibraryIcon, PanelRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkspaceLayout } from './deployment-workspace-shell';

export interface WorkflowEditorToolbarProps {
  workflowName: string;
  layout: DeploymentWorkspaceLayout;
  onOpenLibrary: () => void;
  onOpenInspector: () => void;
  libraryTriggerRef?: React.Ref<HTMLButtonElement>;
  inspectorTriggerRef?: React.Ref<HTMLButtonElement>;
}

export const WorkflowEditorToolbar: React.FC<WorkflowEditorToolbarProps> = ({
  workflowName,
  layout,
  onOpenLibrary,
  onOpenInspector,
  libraryTriggerRef,
  inspectorTriggerRef,
}) => {
  const { t } = useI18n();
  return (
    <header
      className="flex min-h-11 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b px-3 py-1.5"
      data-testid="deployment-editor-toolbar"
    >
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">{workflowName}</h2>
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
          aria-label={t('deployment.editor.nodeLibrary')}
          title={t('deployment.editor.nodeLibrary')}
        >
          <LibraryIcon data-icon="inline-start" />
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

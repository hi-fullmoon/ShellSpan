import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import {
  useDeploymentWorkflowStore,
  type DeploymentWorkflowDraft,
} from '@/stores/deploymentWorkflowStore';

export interface WorkflowSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: DeploymentWorkflowDraft;
  editable: boolean;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onConfigureDeployment?: () => void;
}

export const WorkflowSettingsDialog: React.FC<WorkflowSettingsDialogProps> = ({
  open,
  onOpenChange,
  draft,
  editable,
  returnFocusRef,
  onConfigureDeployment,
}) => {
  const { t } = useI18n();
  const updateWorkflowMeta = useDeploymentWorkflowStore((state) => state.updateWorkflowMeta);
  const [name, setName] = React.useState(draft.name);
  const [enabled, setEnabled] = React.useState(draft.enabled);
  const configureAfterClose = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    setName(draft.name);
    setEnabled(draft.enabled);
  }, [draft.enabled, draft.name, open]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!editable || !normalizedName) return;
    updateWorkflowMeta({ name: normalizedName, enabled });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) return;
        if (configureAfterClose.current) {
          configureAfterClose.current = false;
          onConfigureDeployment?.();
        } else {
          returnFocusRef?.current?.focus();
        }
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('deployment.editor.settings')}</DialogTitle>
            <DialogDescription>{t('deployment.editor.settingsDescription')}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            <Field data-disabled={!editable}>
              <FieldLabel htmlFor="deployment-workflow-settings-name">
                {t('deployment.editor.workflowName')}
              </FieldLabel>
              <Input
                id="deployment-workflow-settings-name"
                className="h-8"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!editable}
                required
                autoFocus
              />
            </Field>
            <Field className="flex-row items-center gap-3" data-disabled={!editable}>
              <div className="min-w-0 flex-1">
                <FieldLabel htmlFor="deployment-workflow-enabled">
                  {t('deployment.editor.enabled')}
                </FieldLabel>
                <FieldDescription>{t('deployment.editor.enabledDescription')}</FieldDescription>
              </div>
              <Switch
                id="deployment-workflow-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={!editable}
                aria-label={t('deployment.editor.enabled')}
              />
            </Field>
          </FieldGroup>
          {onConfigureDeployment && <Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => {
            configureAfterClose.current = true;
            onOpenChange(false);
          }}>
            {t('deployment.application.configure')}
          </Button>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!editable || !name.trim()}>
              {t('deployment.editor.settingsApply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

import React from 'react';
import { AlertTriangleIcon, ServerIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  CompactAlertDialogBody,
  CompactAlertDialogContent,
  CompactAlertDialogDescription,
  CompactAlertDialogFooter,
  CompactAlertDialogHeader,
  CompactAlertDialogTitle,
} from '@/components/ui/compact-alert-dialog';
import { useI18n } from '@/hooks/useI18n';
import type { RunbookRunItem, RunbookTarget } from '@/types/runbook';

interface RunbookDestructiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  target?: RunbookTarget;
  item?: RunbookRunItem;
  onConfirm: () => void;
}

export const RunbookDestructiveDialog: React.FC<RunbookDestructiveDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  target,
  item,
  onConfirm,
}) => {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <CompactAlertDialogContent className="max-w-md">
        <CompactAlertDialogHeader>
          <CompactAlertDialogTitle>{title}</CompactAlertDialogTitle>
          <CompactAlertDialogDescription>{description}</CompactAlertDialogDescription>
        </CompactAlertDialogHeader>
        <CompactAlertDialogBody>
          {target && (
            <Alert>
              <ServerIcon />
              <AlertTitle>{t('runbook.target')}</AlertTitle>
              <AlertDescription className="break-all font-mono text-foreground">
                {target.name} · {target.username}@{target.host}:{target.port}
              </AlertDescription>
            </Alert>
          )}
          {item && (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle className="break-words">{item.impact}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  {item.rollback && (
                    <span>{t('runbook.rollback')}: {item.rollback}</span>
                  )}
                  <code className="block break-all rounded-md bg-muted p-2 font-mono text-foreground">
                    {item.commandPreview}
                  </code>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CompactAlertDialogBody>
        <CompactAlertDialogFooter>
          <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" size="sm" onClick={onConfirm}>
            {t('runbook.confirmDestructive')}
          </AlertDialogAction>
        </CompactAlertDialogFooter>
      </CompactAlertDialogContent>
    </AlertDialog>
  );
};

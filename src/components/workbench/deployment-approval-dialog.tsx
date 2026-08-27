import React, { useEffect, useState } from 'react';
import { ShieldAlertIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';

export interface DeploymentApprovalFact {
  label: string;
  value: React.ReactNode;
}

interface DeploymentApprovalDialogProps {
  open: boolean;
  title: string;
  description: string;
  facts: DeploymentApprovalFact[];
  confirmation: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export const DeploymentApprovalDialog: React.FC<DeploymentApprovalDialogProps> = ({
  open,
  title,
  description,
  facts,
  confirmation,
  confirmLabel,
  destructive = false,
  busy = false,
  onOpenChange,
  onConfirm,
}) => {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) setConfirmed(false);
  }, [open]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldAlertIcon aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          {facts.map((fact) => (
            <React.Fragment key={fact.label}>
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 break-words font-medium">{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>

        <Field className="flex-row items-start gap-3 rounded-lg border p-3" data-disabled={busy}>
          <Checkbox
            id="deployment-approval-confirmation"
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel htmlFor="deployment-approval-confirmation" className="text-foreground">
              {confirmation}
            </FieldLabel>
            <FieldDescription>{t('deployment.approval.oneShot')}</FieldDescription>
          </div>
        </Field>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={!confirmed || busy}
            onClick={onConfirm}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

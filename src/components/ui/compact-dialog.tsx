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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type CompactDialogContentProps = React.ComponentProps<typeof DialogContent>;

export const CompactDialogContent: React.FC<CompactDialogContentProps> = ({
  className,
  ...props
}) => (
  <DialogContent
    className={cn(
      'gap-0 overflow-hidden border-app-border bg-app-surface p-0 [&_[data-slot=dialog-close]]:size-8 sm:rounded-lg',
      className,
    )}
    {...props}
  />
);

interface CompactDialogHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
}

export const CompactDialogHeader: React.FC<CompactDialogHeaderProps> = ({
  title,
  description,
}) => (
  <DialogHeader className="px-4 py-2.5 pr-11">
    <DialogTitle className="text-sm leading-5">{title}</DialogTitle>
    {description && (
      <DialogDescription className="leading-5">{description}</DialogDescription>
    )}
  </DialogHeader>
);

export const CompactDialogBody: React.FC<React.ComponentProps<'div'>> = ({
  className,
  ...props
}) => (
  <div className={cn('flex flex-col gap-3 px-4 py-3', className)} {...props} />
);

export const CompactDialogFooter: React.FC<React.ComponentProps<typeof DialogFooter>> = (
  { className, ...props },
) => (
  <DialogFooter
    className={cn(
      'mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5',
      className,
    )}
    {...props}
  />
);

interface CompactPromptDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: React.ReactNode;
  label: string;
  confirmText: string;
  cancelText: string;
  defaultValue?: string;
}

export const CompactPromptDialog: React.FC<CompactPromptDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  label,
  confirmText,
  cancelText,
  defaultValue = '',
}) => {
  const [value, setValue] = React.useState(defaultValue);
  const inputId = React.useId();

  React.useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const handleConfirm = (): void => {
    if (!value.trim()) return;
    onConfirm(value);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <CompactDialogContent className="max-w-sm" showCloseButton={false}>
        <CompactDialogHeader title={title} />
        <CompactDialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              {label}
            </Label>
            <Input
              id={inputId}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleConfirm();
              }}
              autoFocus
            />
          </div>
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {cancelText}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!value.trim()}>
            {confirmText}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};

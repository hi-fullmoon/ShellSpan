import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyFeedback, type CopySource } from '@/hooks/useCopyFeedback';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

export function CopyFeedbackLabel({ copied, label, copiedLabel, className }: {
  readonly copied: boolean;
  readonly label: React.ReactNode;
  readonly copiedLabel?: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  return <span className={cn('grid text-left', className)}>
    <span className={cn('col-start-1 row-start-1', copied && 'invisible')} aria-hidden={copied || undefined}>{label}</span>
    <span className={cn('col-start-1 row-start-1', !copied && 'invisible')} aria-hidden={!copied || undefined}>{copiedLabel ?? t('common.copied')}</span>
  </span>;
}

export function CopyButton({ text, label, errorLabel, copiedLabel, iconOnly = false, ...props }: Omit<React.ComponentProps<typeof Button>, 'onClick' | 'children'> & {
  readonly text: CopySource;
  readonly label: string;
  readonly errorLabel?: string;
  readonly copiedLabel?: string;
  readonly iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback(errorLabel);
  const feedback = copiedLabel ?? t('common.copied');
  const activeLabel = copied ? feedback : label;
  const mirrorLabel = copied ? label : feedback;
  const button = <Button type="button" variant="ghost" {...props}
    aria-label={activeLabel} onClick={() => { void copy(text); }}>
    {iconOnly ? (
      copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />
    ) : (
      <span className="grid place-items-center">
        <span className="col-start-1 row-start-1 inline-flex items-center gap-1">
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          <span>{activeLabel}</span>
        </span>
        <span className="invisible pointer-events-none col-start-1 row-start-1 inline-flex items-center gap-1 select-none" aria-hidden="true">
          <svg aria-hidden="true" />
          <span>{mirrorLabel}</span>
        </span>
      </span>
    )}
  </Button>;
  return iconOnly ? <Tooltip>
    <TooltipTrigger render={button} />
    <TooltipContent>{activeLabel}</TooltipContent>
  </Tooltip> : button;
}

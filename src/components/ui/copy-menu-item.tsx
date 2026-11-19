import { Check, Copy } from 'lucide-react';
import type { ComponentType } from 'react';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useI18n } from '@/hooks/useI18n';
import { CopyFeedbackLabel } from '@/components/ui/copy-button';
import { useCopyFeedback, type CopySource } from '@/hooks/useCopyFeedback';

export function CopyMenuItem({ text, label, errorLabel, disabled, icon: Icon = Copy, children }: {
  readonly text: CopySource;
  readonly label: string;
  readonly errorLabel: string;
  readonly disabled?: boolean;
  readonly icon?: ComponentType;
  readonly children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback(errorLabel);
  return <ContextMenuItem
    closeOnClick={false}
    disabled={disabled}
    label={label}
    aria-label={copied ? t('common.copied') : label}
    onClick={() => { void copy(text); }}
  >
    {copied ? <Check /> : <Icon />}
    <CopyFeedbackLabel copied={copied} label={label} className="relative top-px" />
    {children}
  </ContextMenuItem>;
}

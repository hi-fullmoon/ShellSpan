import { CheckIcon } from 'lucide-react';
import { CopyFeedbackLabel } from '@/components/ui/copy-button';
import { useCopyFeedback, type CopyAction } from '@/hooks/useCopyFeedback';
import { cn } from '@/lib/utils';

export function SftpCopyMenuItem({ onCopy, disabled, icon, label, offsetText = false }: {
  readonly onCopy: CopyAction;
  readonly disabled?: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly offsetText?: boolean;
}) {
  const { copied, run } = useCopyFeedback();
  return <button type="button" role="menuitem" tabIndex={-1} disabled={disabled}
    onClick={() => { void run(onCopy); }}
    className="flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-xs text-app-text transition-colors focus:bg-accent focus:text-app-primary focus-visible:outline-hidden! disabled:pointer-events-none disabled:opacity-40">
    <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
      {copied ? <CheckIcon className="size-3.5" /> : icon}
    </span>
    <span className={cn('leading-4', offsetText && 'relative top-px')}>
      <CopyFeedbackLabel copied={copied} label={label} />
    </span>
  </button>;
}

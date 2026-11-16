import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export const submissionFeedbackMs = 320;

export function AiSubmissionButtonLabel({ label, busy, busyLabel }: {
  readonly label: string;
  readonly busy: boolean;
  readonly busyLabel?: string;
}): React.ReactNode {
  return <span className="grid">
    <span className={cn('col-start-1 row-start-1', busy && 'invisible')} aria-hidden={busy || undefined}>{label}</span>
    {busy && <>
      <Spinner aria-hidden="true" className="col-start-1 row-start-1 place-self-center" />
      {busyLabel && <span className="sr-only">{busyLabel}</span>}
    </>}
  </span>;
}

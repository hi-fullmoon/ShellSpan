import { CircleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export interface AiErrorNoticeProps
  extends Omit<React.ComponentProps<typeof Alert>, 'children' | 'size' | 'variant'> {
  readonly title: string;
  readonly label?: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}

/** Compact error feedback shared by transient AI Panel operations. */
export function AiErrorNotice({
  title,
  label,
  action,
  children,
  className,
  ...props
}: AiErrorNoticeProps): React.ReactNode {
  return (
    <Alert
      data-ai-error-notice=""
      variant="destructiveSubtle"
      size="xs"
      className={cn('items-center', className)}
      {...props}
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="sr-only">{title}</AlertTitle>
      <AlertDescription className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 break-words">
          {label && (
            <>
              <strong className="font-medium text-foreground">{label}</strong>
              {' · '}
            </>
          )}
          <span>{children}</span>
        </span>
        {action && <span className="shrink-0">{action}</span>}
      </AlertDescription>
    </Alert>
  );
}

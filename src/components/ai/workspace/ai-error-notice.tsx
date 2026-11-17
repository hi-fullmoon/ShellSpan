import { CircleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { AI_NOTICE_ACTION_ROW_CLASS, AI_NOTICE_COPY_CLASS, AI_NOTICE_COPY_WITH_ACTION_CLASS } from './ai-style-classes';

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
      size="sm"
      className={cn('items-center', action && '[--alert-icon-inset:--spacing(1)]', className)}
      {...props}
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle className="sr-only">{title}</AlertTitle>
      <AlertDescription className={AI_NOTICE_ACTION_ROW_CLASS}>
        <span className={cn(AI_NOTICE_COPY_CLASS, action && AI_NOTICE_COPY_WITH_ACTION_CLASS)}>
          {label && (
            <>
              <strong className="font-medium text-foreground">{label}</strong>
              {' · '}
            </>
          )}
          <span>{children}</span>
        </span>
        {action}
      </AlertDescription>
    </Alert>
  );
}

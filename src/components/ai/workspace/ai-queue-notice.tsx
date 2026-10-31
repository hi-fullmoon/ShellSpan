import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { AiToolCopyButton } from './ai-tool-presentation';
import { AI_CONTENT_CODE_CLASS } from './ai-style-classes';

export function AiQueueNotice({ conflict, error, onRetry }: {
  readonly conflict: boolean;
  readonly error: string | null;
  readonly onRetry?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const Icon = conflict ? TriangleAlertIcon : CircleAlertIcon;
  return (
    <Alert variant={conflict ? 'warning' : 'default'} size="sm" className={cn('min-w-0', !conflict && 'ai-queue-failure-notice')}>
      <Icon aria-hidden="true" />
      <AlertTitle className="min-w-0 break-words">
        {t(conflict ? 'ai.workspace.queue.conflict' : 'ai.workspace.queue.failure')}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        {t(conflict ? 'ai.workspace.queue.conflictHint' : 'ai.workspace.queue.failureHint')}
        {onRetry && <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
          {t('common.retry')}
        </Button>}
        {error && <Collapsible key={error} className="mt-1 min-w-0">
          <CollapsibleTrigger render={<Button variant="ghost" size="xs" />} className="group gap-1 text-[11px]">
            {t('ai.workspace.queue.errorDetails')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="ai-queue-notice-preview ai-tool-content-region relative mt-1 min-w-0 overflow-hidden" data-ai-copy-region>
              <div className={cn(AI_CONTENT_CODE_CLASS, 'max-h-65 overflow-y-auto whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]')} tabIndex={0}>{error}</div>
              <AiToolCopyButton text={error} label={t('ai.workspace.tool.copyOutput')} />
            </div>
          </CollapsibleContent>
        </Collapsible>}
      </AlertDescription>
    </Alert>
  );
}

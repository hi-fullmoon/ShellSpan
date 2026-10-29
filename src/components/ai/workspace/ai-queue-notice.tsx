import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { AiToolCopyButton } from './ai-tool-presentation';

export function AiQueueNotice({ conflict, error }: {
  readonly conflict: boolean;
  readonly error: string | null;
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
        {error && <Collapsible key={error} className="mt-1 min-w-0">
          <CollapsibleTrigger render={<Button variant="ghost" size="xs" />} className="group gap-1 text-[11px]">
            {t('ai.workspace.queue.errorDetails')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="ai-queue-notice-preview relative mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap p-2 pr-10 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]" tabIndex={0}>
              {error}
              <AiToolCopyButton text={error} label={t('ai.workspace.tool.copyOutput')} className="ai-content-copy absolute top-1 right-1" />
            </div>
          </CollapsibleContent>
        </Collapsible>}
      </AlertDescription>
    </Alert>
  );
}

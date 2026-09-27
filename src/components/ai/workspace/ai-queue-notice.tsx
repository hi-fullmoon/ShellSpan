import { ChevronDownIcon, CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';

export function AiQueueNotice({ conflict, error }: {
  readonly conflict: boolean;
  readonly error: string | null;
}): React.ReactNode {
  const { t } = useI18n();
  const Icon = conflict ? TriangleAlertIcon : CircleAlertIcon;
  return (
    <Alert variant={conflict ? 'warning' : 'destructiveSubtle'} size="sm" className="min-w-0">
      <Icon aria-hidden="true" />
      <AlertTitle className="min-w-0 break-words">
        {t(conflict ? 'ai.workspace.queue.conflict' : 'ai.workspace.queue.failure')}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        {t(conflict ? 'ai.workspace.queue.conflictHint' : 'ai.workspace.queue.failureHint')}
        {error && <Collapsible key={error} className="mt-1 min-w-0">
          <CollapsibleTrigger render={<Button variant="ghost" size="xs" />} className="group gap-1">
            {t('ai.workspace.queue.errorDetails')}
            <ChevronDownIcon data-icon="inline-end" className="group-data-[panel-open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {error}
            </div>
          </CollapsibleContent>
        </Collapsible>}
      </AlertDescription>
    </Alert>
  );
}

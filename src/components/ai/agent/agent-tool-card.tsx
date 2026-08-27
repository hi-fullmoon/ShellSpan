import { useState } from 'react';
import {
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleDotDashedIcon,
  ClockAlertIcon,
  SquareTerminalIcon,
  SquareIcon,
  XCircleIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type { AgentToolCallSnapshotV1, AgentToolCallStateV1 } from '@/types/agent';

type BadgeVariant = 'default' | 'outline' | 'secondary' | 'destructive';

const stateIcon = {
  proposed: CircleDotDashedIcon,
  validating: CircleDotDashedIcon,
  executing: SquareTerminalIcon,
  completed: CheckCircle2Icon,
  failed: XCircleIcon,
  timedOut: ClockAlertIcon,
  cancelled: SquareIcon,
  denied: BanIcon,
} satisfies Record<AgentToolCallStateV1, React.ComponentType>;

function stateVariant(state: AgentToolCallStateV1): BadgeVariant {
  if (state === 'failed' || state === 'timedOut' || state === 'denied') return 'destructive';
  if (state === 'completed') return 'default';
  if (state === 'cancelled') return 'outline';
  return 'secondary';
}

function toolArgumentSummary(toolCall: AgentToolCallSnapshotV1): string {
  if (toolCall.tool === 'host.inspect' && 'include' in toolCall.arguments) {
    return toolCall.arguments.include.join(', ');
  }
  if ('program' in toolCall.arguments) {
    return [toolCall.arguments.program, ...toolCall.arguments.args].join(' ');
  }
  return toolCall.tool;
}

export function AgentToolCard({
  toolCall,
  onEvidenceNavigate,
}: {
  toolCall: AgentToolCallSnapshotV1;
  onEvidenceNavigate: (evidenceId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [outputOpen, setOutputOpen] = useState(false);
  const Icon = stateIcon[toolCall.state];
  const result = toolCall.result;
  const duration = result ? Math.max(0, result.completedAt - result.startedAt) : undefined;
  const capturedBytes = result
    ? result.stdoutBytesCaptured + result.stderrBytesCaptured
    : undefined;
  const readBytes = result ? result.stdoutBytesRead + result.stderrBytesRead : undefined;
  const truncated = Boolean(result?.stdoutTruncated || result?.stderrTruncated);
  const hasOutput = Boolean(result?.stdoutExcerpt || result?.stderrExcerpt);

  return (
    <Card size="sm" variant="outline" data-tool-state={toolCall.state}>
      <CardHeader>
        <CardTitle>{toolCall.tool}</CardTitle>
        <CardDescription className="flex flex-col gap-1">
          <span>{toolCall.purpose}</span>
          <span>{toolCall.rationale}</span>
        </CardDescription>
        <CardAction>
          <Badge variant={stateVariant(toolCall.state)}>
            {toolCall.state === 'executing'
              ? <Spinner data-icon="inline-start" />
              : <Icon data-icon="inline-start" />}
            {t(`ai.dynamicAgent.tool.status.${toolCall.state}` as LocaleKey)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <code className="break-all rounded-lg bg-muted p-2 text-xs leading-5 text-foreground">
          {toolCall.commandPreview
            ?? (toolCall.tool === 'host.inspect'
              ? toolArgumentSummary(toolCall)
              : t('ai.dynamicAgent.tool.previewPending'))}
        </code>
        <p className="text-xs leading-4 text-muted-foreground">
          {t('ai.dynamicAgent.tool.independentExec')}
        </p>
        <p className="text-xs leading-4 text-muted-foreground">
          {toolCall.successCriteria}
        </p>

        {result && (
          <div className="flex flex-wrap gap-1.5">
            {result.exitCode !== undefined && (
              <Badge variant={result.exitCode === 0 ? 'secondary' : 'destructive'}>
                {t('ai.dynamicAgent.tool.exitCode', { code: result.exitCode })}
              </Badge>
            )}
            {duration !== undefined && (
              <Badge variant="outline">
                {t('ai.dynamicAgent.tool.duration', { duration })}
              </Badge>
            )}
            {capturedBytes !== undefined && readBytes !== undefined && (
              <Badge variant="outline">
                {t('ai.dynamicAgent.tool.bytes', {
                  captured: capturedBytes,
                  read: readBytes,
                })}
              </Badge>
            )}
            {truncated && (
              <Badge variant="destructive">{t('ai.dynamicAgent.tool.truncated')}</Badge>
            )}
          </div>
        )}

        {result?.error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{t(`ai.dynamicAgent.tool.status.${toolCall.state}` as LocaleKey)}</AlertTitle>
            <AlertDescription>
              {result.error.message}
              {result.error.suggestion ? ` ${result.error.suggestion}` : ''}
            </AlertDescription>
          </Alert>
        )}

        {hasOutput && (
          <Collapsible open={outputOpen} onOpenChange={setOutputOpen}>
            <CollapsibleTrigger
              render={<Button variant="outline" size="sm" className="w-full justify-between" />}
              aria-expanded={outputOpen}
            >
              {t('ai.dynamicAgent.tool.outputDetails')}
              <ChevronDownIcon data-icon="inline-end" />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2 pt-2">
              {result?.stdoutExcerpt && (
                <section aria-label={t('ai.dynamicAgent.tool.stdout')} className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {t('ai.dynamicAgent.tool.stdout')}
                  </h4>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs leading-5 whitespace-pre-wrap break-words text-foreground">
                    {result.stdoutExcerpt}
                  </pre>
                </section>
              )}
              {result?.stderrExcerpt && (
                <section aria-label={t('ai.dynamicAgent.tool.stderr')} className="flex flex-col gap-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {t('ai.dynamicAgent.tool.stderr')}
                  </h4>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs leading-5 whitespace-pre-wrap break-words text-foreground">
                    {result.stderrExcerpt}
                  </pre>
                </section>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
      {toolCall.evidenceIds.length > 0 && (
        <CardFooter className="flex-wrap gap-1.5">
          {toolCall.evidenceIds.map((evidenceId) => (
            <Button
              key={evidenceId}
              variant="link"
              size="xs"
              className="px-0"
              onClick={() => onEvidenceNavigate(evidenceId)}
            >
              {evidenceId}
            </Button>
          ))}
        </CardFooter>
      )}
    </Card>
  );
}

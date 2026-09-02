import { useEffect, useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import type {
  AgentConversationToolItem,
  AgentSessionToolStatus,
} from '@/types/agent-session';

function statusVariant(
  status: AgentSessionToolStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'failed' || status === 'timedOut' || status === 'cancelled') return 'destructive';
  if (status === 'running' || status === 'awaitingApproval') return 'secondary';
  return 'outline';
}

function effectVariant(
  effect: AgentConversationToolItem['effect'],
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (effect === 'destructive') return 'destructive';
  if (effect === 'stateChange') return 'secondary';
  return 'outline';
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AgentToolRow({ tool }: { readonly tool: AgentConversationToolItem }): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(tool.status !== 'completed');

  useEffect(() => {
    if (tool.status === 'completed') setOpen(false);
  }, [tool.status]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card size="sm" variant="outline" data-slot="agent-session-tool">
        <CardHeader>
          <CardTitle>{tool.title}</CardTitle>
          <CardDescription className="flex min-w-0 flex-col gap-0.5">
            {tool.target?.label && <span className="truncate">{tool.target.label}</span>}
            {tool.summary && <span className="truncate">{tool.summary}</span>}
          </CardDescription>
          <CardAction className="flex items-center gap-1">
            <Badge variant={effectVariant(tool.effect)}>
              {tool.effect === 'unknown'
                ? t('agent.session.effect.unknown')
                : t(`agent.risk.${tool.effect}` as LocaleKey)}
            </Badge>
            <Badge variant={statusVariant(tool.status)} role="status">
              {t(`agent.status.${tool.status}` as LocaleKey)}
            </Badge>
            <CollapsibleTrigger
              render={(
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={open ? t('agent.tool.collapse') : t('agent.tool.expand')}
                />
              )}
            >
              <ChevronRightIcon className={cn('transition-transform', open && 'rotate-90')} />
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            <dl className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs font-medium text-muted-foreground">
                  {t('agent.session.tool.arguments')}
                </dt>
                <dd>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
                    {printable(tool.arguments)}
                  </pre>
                </dd>
              </div>
              {(tool.resultSummary || tool.result !== undefined) && (
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t('agent.session.tool.output')}
                  </dt>
                  <dd>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
                      {tool.resultSummary || printable(tool.result)}
                    </pre>
                  </dd>
                </div>
              )}
              {tool.evidenceRefs.length > 0 && (
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t('agent.session.tool.evidence')}
                  </dt>
                  <dd className="flex flex-wrap gap-1">
                    {tool.evidenceRefs.map((reference) => (
                      <Badge key={reference} variant="outline">{reference}</Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

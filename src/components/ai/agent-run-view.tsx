import React from 'react';
import {
  CheckCircle2Icon,
  CircleIcon,
  Clock3Icon,
  ShieldAlertIcon,
  TerminalIcon,
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
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { AgentRun, AgentRunStep } from '@/types/ai';
import { Marker, MessageScroller } from './chat-primitives';

function statusIcon(step: AgentRunStep): React.ReactNode {
  if (step.status === 'running') return <Spinner data-icon="inline-start" />;
  if (step.status === 'completed' || step.status === 'approved') return <CheckCircle2Icon data-icon="inline-start" />;
  if (step.status === 'rejected' || step.status === 'failed') return <XCircleIcon data-icon="inline-start" />;
  if (step.status === 'awaitingApproval') return <Clock3Icon data-icon="inline-start" />;
  return <CircleIcon data-icon="inline-start" />;
}

export const AgentRunView: React.FC<{
  run?: AgentRun;
  onApprove: (step: AgentRunStep) => void;
  onReject: (stepId: string) => void;
  canInsert: boolean;
}> = ({ run, onApprove, onReject, canInsert }) => {
  const { t } = useI18n();

  if (!run) {
    return (
      <MessageScroller className="flex-1" followKey="empty-agent">
        <Marker>
          <ShieldAlertIcon className="mx-auto mb-2 size-6" />
          {t('ai.agent.empty')}
        </Marker>
      </MessageScroller>
    );
  }

  return (
    <MessageScroller
      className="flex-1"
      followKey={`${run.phase}:${run.steps.length}:${run.responseText.length}`}
    >
      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>{t('ai.agent.goal')}</AlertTitle>
        <AlertDescription>{run.goal}</AlertDescription>
      </Alert>

      {run.summary && (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>{t('ai.agent.summary')}</AlertTitle>
          <AlertDescription>{run.summary}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{t('ai.agent.steps')}</span>
        <Badge variant={run.phase === 'error' ? 'destructive' : 'outline'}>
          {t(`ai.agent.phase.${run.phase}`)}
        </Badge>
      </div>

      {run.steps.map((step, index) => (
        <Card key={step.id} size="sm">
          <CardHeader>
            <CardTitle>{index + 1}. {step.title}</CardTitle>
            {step.description && <CardDescription>{step.description}</CardDescription>}
            <CardAction>
              <Badge variant={step.status === 'failed' ? 'destructive' : 'secondary'}>
                {statusIcon(step)}
                {t(`ai.agent.stepStatus.${step.status}`)}
              </Badge>
            </CardAction>
          </CardHeader>
          {step.command && (
            <CardContent>
              <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-foreground">
                {step.command}
              </code>
            </CardContent>
          )}
          {step.status === 'awaitingApproval' && step.command && (
            <CardFooter className="justify-end gap-2">
              <Button variant="ghost" size="xs" onClick={() => onReject(step.id)}>
                <XCircleIcon data-icon="inline-start" />
                {t('ai.agent.reject')}
              </Button>
              <Button size="xs" onClick={() => onApprove(step)} disabled={!canInsert}>
                <TerminalIcon data-icon="inline-start" />
                {t('ai.agent.approveInsert')}
              </Button>
            </CardFooter>
          )}
        </Card>
      ))}

      {run.phase === 'planning' && (
        <Marker>{t('ai.agent.planningHint')}</Marker>
      )}

      {run.error && (
        <Alert variant="destructive">
          <AlertTitle>{t('ai.agent.failed')}</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}
    </MessageScroller>
  );
};

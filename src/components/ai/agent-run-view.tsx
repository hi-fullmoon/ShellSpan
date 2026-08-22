import React from 'react';
import {
  CheckCircle2Icon,
  CircleIcon,
  Clock3Icon,
  InfoIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquareIcon,
  TerminalIcon,
  XCircleIcon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
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
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { AgentRun, AgentRunStep } from '@/types/ai';
import { Marker, MessageScroller } from './chat-primitives';

function statusIcon(step: AgentRunStep): React.ReactNode {
  if (step.status === 'running') return <Spinner data-icon="inline-start" />;
  if (step.status === 'completed') return <CheckCircle2Icon data-icon="inline-start" />;
  if (step.status === 'informational') return <InfoIcon data-icon="inline-start" />;
  if (step.status === 'inserted') return <TerminalIcon data-icon="inline-start" />;
  if (step.status === 'rejected' || step.status === 'failed') return <XCircleIcon data-icon="inline-start" />;
  if (step.status === 'awaitingApproval') return <Clock3Icon data-icon="inline-start" />;
  return <CircleIcon data-icon="inline-start" />;
}

export const AgentRunView: React.FC<{
  run?: AgentRun;
  onApprove: (step: AgentRunStep) => void;
  onReject: (stepId: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onActivateSession: () => void;
  canInsert: boolean;
  sessionState: 'ready' | 'inactive' | 'unavailable';
}> = ({
  run,
  onApprove,
  onReject,
  onCancel,
  onRetry,
  onActivateSession,
  canInsert,
  sessionState,
}) => {
  const { t } = useI18n();

  if (!run) {
    return (
      <div className="min-h-0 flex-1">
        <PanelEmptyState
          icon={<ShieldAlertIcon />}
          title={t('ai.mode.agent')}
          description={t('ai.agent.empty')}
        />
      </div>
    );
  }

  const commandSteps = run.steps.filter((step) => (
    step.kind === 'command' && step.status !== 'superseded'
  ));
  const resolvedCommands = commandSteps.filter((step) => (
    step.status === 'completed' || step.status === 'rejected'
  )).length;
  const active = run.phase === 'awaitingApproval' || run.phase === 'awaitingExecution';
  const hasInsertedCommand = run.steps.some((step) => step.status === 'inserted');

  return (
    <MessageScroller
      className="flex-1"
      followKey={`${run.phase}:${run.steps.length}:${run.responseText.length}`}
      ariaLabel={t('ai.agent.runLog')}
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

      {active && (
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>{t('ai.agent.safetyTitle')}</AlertTitle>
          <AlertDescription>{t('ai.agent.safetyDescription')}</AlertDescription>
        </Alert>
      )}

      {active && sessionState !== 'ready' && (
        <Alert variant={sessionState === 'unavailable' ? 'destructive' : 'default'}>
          <TerminalIcon />
          <AlertTitle>{t('ai.agent.sessionAttention')}</AlertTitle>
          <AlertDescription>
            {sessionState === 'inactive'
              ? t('ai.agent.sessionInactive', { name: run.contextLabel })
              : t('ai.agent.sessionUnavailable', { name: run.contextLabel })}
          </AlertDescription>
          {sessionState === 'inactive' && (
            <AlertAction>
              <Button variant="outline" size="xs" onClick={onActivateSession}>
                <TerminalIcon data-icon="inline-start" />
                {t('ai.agent.switchSession')}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">{t('ai.agent.steps')}</div>
          {commandSteps.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {t('ai.agent.progress', { completed: resolvedCommands, total: commandSteps.length })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {active && !hasInsertedCommand && (
            <Button variant="ghost" size="xs" onClick={onCancel}>
              <SquareIcon data-icon="inline-start" />
              {t('ai.agent.stopRun')}
            </Button>
          )}
          {active && hasInsertedCommand && (
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="ghost" size="xs" />}>
                <SquareIcon data-icon="inline-start" />
                {t('ai.agent.stopRun')}
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('ai.agent.stopInsertedTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('ai.agent.stopInsertedDescription')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={onCancel}>
                    {t('ai.agent.clearedStop')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {(run.phase === 'error' || run.phase === 'cancelled') && (
            <Button variant="outline" size="xs" onClick={onRetry}>
              <RotateCcwIcon data-icon="inline-start" />
              {t('ai.agent.retry')}
            </Button>
          )}
          <Badge variant={run.phase === 'error' ? 'destructive' : 'outline'}>
            {t(`ai.agent.phase.${run.phase}`)}
          </Badge>
        </div>
      </div>

      {run.steps.map((step, index) => (
        <Card key={step.id} size="sm">
          <CardHeader>
            <CardTitle>
              {index + 1}. {step.title === 'terminal.getContext'
                ? t('ai.agent.tool.context')
                : step.title === 'diagnosticAgent.plan'
                  ? t('ai.agent.tool.plan')
                  : step.title === 'diagnosticAgent.evaluate'
                    ? t('ai.agent.tool.evaluate')
                    : step.title}
            </CardTitle>
            {step.description && <CardDescription>{step.description}</CardDescription>}
            <CardAction>
              <Badge variant={step.status === 'failed' ? 'destructive' : 'secondary'}>
                {statusIcon(step)}
                {t(`ai.agent.stepStatus.${step.status}`)}
              </Badge>
            </CardAction>
          </CardHeader>
          {(step.command || step.result) && (
            <CardContent className="flex flex-col gap-2">
              {step.command && (
                <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
                  {step.command}
                </code>
              )}
              {step.exitCode !== undefined && (
                <Badge variant={step.exitCode === 0 ? 'outline' : 'destructive'}>
                  {t('ai.agent.exitCode', { code: step.exitCode })}
                </Badge>
              )}
              {step.result && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('ai.agent.capturedOutput')}
                  </span>
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground">
                    {step.result}
                  </pre>
                </div>
              )}
            </CardContent>
          )}
          {step.status === 'awaitingApproval' && step.command && (
            <CardFooter className="justify-end gap-2">
              <Button variant="ghost" size="xs" onClick={() => onReject(step.id)}>
                <XCircleIcon data-icon="inline-start" />
                {t('ai.agent.skip')}
              </Button>
              <Button size="xs" onClick={() => onApprove(step)} disabled={!canInsert}>
                <TerminalIcon data-icon="inline-start" />
                {t('ai.agent.approveInsert')}
              </Button>
            </CardFooter>
          )}
          {step.status === 'inserted' && step.command && (
            <CardFooter className="items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t('ai.agent.waitingForCommand')}
              </span>
              <Button variant="ghost" size="xs" onClick={() => onReject(step.id)}>
                <XCircleIcon data-icon="inline-start" />
                {t('ai.agent.clearedSkip')}
              </Button>
            </CardFooter>
          )}
        </Card>
      ))}

      {run.phase === 'planning' && (
        <Marker><span className="shimmer">{t('ai.agent.planningHint')}</span></Marker>
      )}

      {run.phase === 'evaluating' && (
        <Marker><span className="shimmer">{t('ai.agent.evaluatingHint')}</span></Marker>
      )}

      {run.phase === 'completed' && (
        <Marker>{t('ai.agent.completedHint')}</Marker>
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

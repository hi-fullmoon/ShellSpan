import React from 'react';
import {
  CheckCircle2Icon,
  FilePenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SquareIcon,
  TargetIcon,
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
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import type { AgentRun, AgentRunStep, DiagnosticAgentPlanStep } from '@/types/ai';
import { MessageScroller } from './chat-primitives';

function statusIcon(step: AgentRunStep): React.ReactNode {
  if (step.status === 'running') return <Spinner data-icon="inline-start" />;
  if (step.status === 'completed') return <CheckCircle2Icon data-icon="inline-start" />;
  if (step.status === 'informational') return <InfoIcon data-icon="inline-start" />;
  return <XCircleIcon data-icon="inline-start" />;
}

function riskVariant(
  risk: DiagnosticAgentPlanStep['risk'],
): 'outline' | 'secondary' | 'destructive' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'stateChange') return 'secondary';
  return 'outline';
}

function stepStatusVariant(status: AgentRunStep['status']): 'outline' | 'secondary' | 'destructive' {
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'secondary';
  return 'outline';
}

export const AgentRunView: React.FC<{
  run?: AgentRun;
  onCancel: () => void;
  onRetry: () => void;
  onReviewRunbook: () => void;
}> = ({ run, onCancel, onRetry, onReviewRunbook }) => {
  const { t } = useI18n();

  if (!run) {
    return (
      <div className="min-h-0 flex-1">
        <PanelEmptyState
          icon={<ShieldCheckIcon />}
          title={t('ai.mode.agent')}
          description={t('ai.agent.empty')}
        />
      </div>
    );
  }

  const plan = run.plan;
  const planning = run.phase === 'planning';

  const stepTitle = (step: AgentRunStep): string => (
    step.title === 'terminal.getContext'
      ? t('ai.agent.tool.context')
      : step.title === 'remoteHealth.getSnapshotContext'
        ? t('ai.agent.tool.remoteHealth')
        : step.title === 'diagnosticAgent.plan'
          ? t('ai.agent.tool.plan')
          : step.title
  );

  return (
    <MessageScroller
      className="flex-1"
      followKey={`${run.phase}:${run.steps.length}:${run.responseText.length}`}
      ariaLabel={t('ai.agent.runLog')}
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <TargetIcon className="size-4" />
            </span>
            {run.goal}
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5 pl-9">
            <ServerIcon className="size-3.5 shrink-0" />
            <span className="truncate">{run.contextLabel}</span>
          </CardDescription>
          <CardAction>
            <Badge variant={run.phase === 'error' ? 'destructive' : 'secondary'}>
              {planning && <Spinner data-icon="inline-start" />}
              {t(`ai.agent.phase.${run.phase}` as LocaleKey)}
            </Badge>
          </CardAction>
        </CardHeader>
        {plan && (
          <CardContent className="flex flex-col gap-3">
            <Separator />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('ai.agent.objective')}
              </span>
              <span className="text-sm leading-5">{plan.objective}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('ai.agent.target')}
              </span>
              <span className="text-sm leading-5">{plan.target}</span>
            </div>
          </CardContent>
        )}
      </Card>

      <Alert className="bg-muted/40">
        <ShieldCheckIcon />
        <AlertTitle>{t('ai.agent.safetyTitle')}</AlertTitle>
        <AlertDescription>{t('ai.agent.safetyDescription')}</AlertDescription>
      </Alert>

      {plan && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t('ai.agent.summary')}</CardTitle>
            <CardDescription>{plan.summary}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-foreground">
                {t('ai.agent.assumptions')}
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-muted-foreground">
                {plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
              </ul>
            </div>
            <Separator />
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-xs font-medium text-foreground">
                  {t('ai.agent.evidence')}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t('ai.agent.evidenceDescription')}
                </div>
              </div>
              {plan.evidence.map((evidence) => {
                const contextAgeSeconds = Math.floor((Date.now() - run.contextObservedAt) / 1000);
                const stale = evidence.source === 'context'
                  && contextAgeSeconds >= evidence.maxAgeSeconds;
                return (
                  <div key={evidence.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{evidence.description}</div>
                      <div className="text-xs leading-5 text-muted-foreground">
                        {evidence.source === 'context'
                          ? `${run.contextSource === 'remoteHealth'
                            ? t('ai.agent.tool.remoteHealth')
                            : t('ai.agent.tool.context')} · ${new Date(run.contextObservedAt).toLocaleString()}`
                          : `${t('ai.agent.evidenceFromStep')} ${evidence.sourceStepId}`}
                        {' · '}{t('ai.agent.evidenceMaxAge', { seconds: evidence.maxAgeSeconds })}
                      </div>
                    </div>
                    <Badge variant={stale ? 'destructive' : evidence.source === 'context' ? 'outline' : 'secondary'}>
                      {stale
                        ? t('ai.agent.evidenceStale')
                        : evidence.source === 'context'
                          ? t('ai.agent.evidenceAttached')
                          : t('ai.agent.evidencePending')}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <section className="flex flex-col gap-3" aria-label={t('ai.agent.steps')}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-foreground">{t('ai.agent.steps')}</div>
          <div className="flex items-center gap-1">
            {planning && (
              <Button variant="ghost" size="xs" onClick={onCancel}>
                <SquareIcon data-icon="inline-start" />
                {t('ai.agent.stopRun')}
              </Button>
            )}
            {(run.phase === 'error' || run.phase === 'cancelled') && (
              <Button variant="ghost" size="xs" onClick={onRetry}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('ai.agent.retry')}
              </Button>
            )}
          </div>
        </div>

        {run.error && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>{t('ai.agent.failed')}</AlertTitle>
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col">
          {run.steps.map((step, index) => (
            <div
              key={step.id}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3"
              aria-current={step.status === 'running' ? 'step' : undefined}
            >
              <div className="flex flex-col items-center">
                <Badge
                  variant={step.status === 'running' ? 'secondary' : 'outline'}
                  className="size-7 rounded-full p-0"
                >
                  {index + 1}
                </Badge>
                {index < run.steps.length - 1 && (
                  <Separator orientation="vertical" className="min-h-4 flex-1" />
                )}
              </div>
              <Card
                size="sm"
                className={cn('mb-3', step.status === 'running' && 'ring-primary/30')}
              >
                <CardHeader>
                  <CardTitle>{stepTitle(step)}</CardTitle>
                  {step.description && <CardDescription>{step.description}</CardDescription>}
                  <CardAction>
                    <Badge variant={stepStatusVariant(step.status)}>
                      {statusIcon(step)}
                      {t(`ai.agent.stepStatus.${step.status}` as LocaleKey)}
                    </Badge>
                  </CardAction>
                </CardHeader>
                {step.kind === 'command' && step.command && step.risk && (
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={riskVariant(step.risk)}>
                        {t(`runbook.risk.${step.risk}` as LocaleKey)}
                      </Badge>
                      {step.evidenceIds?.map((evidenceId) => (
                        <Badge key={evidenceId} variant="outline">{evidenceId}</Badge>
                      ))}
                    </div>
                    <code className="break-all rounded-lg bg-muted p-3 text-xs leading-5 text-foreground">
                      {step.command}
                    </code>
                    <div className="grid gap-2 text-xs leading-5 text-muted-foreground">
                      <span><strong className="font-medium text-foreground">{t('runbook.impact')}:</strong> {step.impact}</span>
                      <span><strong className="font-medium text-foreground">{t('runbook.rollback')}:</strong> {step.rollback}</span>
                      <span><strong className="font-medium text-foreground">{t('runbook.timeout')}:</strong> {step.timeoutSeconds}s</span>
                    </div>
                  </CardContent>
                )}
              </Card>
            </div>
          ))}
        </div>
      </section>

      {plan && ['awaitingReview', 'handedOff'].includes(run.phase) && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t('ai.agent.reviewRunbookTitle')}</CardTitle>
            <CardDescription>{t('ai.agent.reviewRunbookDescription')}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-end">
            <Button onClick={onReviewRunbook}>
              <FilePenLineIcon data-icon="inline-start" />
              {t('ai.agent.reviewRunbook')}
            </Button>
          </CardFooter>
        </Card>
      )}
    </MessageScroller>
  );
};

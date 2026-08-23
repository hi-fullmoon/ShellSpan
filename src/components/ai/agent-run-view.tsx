import React from 'react';
import {
  CheckCircle2Icon,
  FilePenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
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
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
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
          icon={<ShieldAlertIcon />}
          title={t('ai.mode.agent')}
          description={t('ai.agent.empty')}
        />
      </div>
    );
  }

  const plan = run.plan;
  const planning = run.phase === 'planning';

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

      {plan && (
        <>
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>{t('ai.agent.objective')}</AlertTitle>
            <AlertDescription>
              <div className="flex flex-col gap-1">
                <span>{plan.objective}</span>
                <span>{t('ai.agent.target')}: {plan.target}</span>
                <span>{t('ai.agent.boundTarget')}: {run.contextLabel}</span>
              </div>
            </AlertDescription>
          </Alert>

          <Card size="sm">
            <CardHeader>
              <CardTitle>{t('ai.agent.assumptions')}</CardTitle>
              <CardDescription>{plan.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                {plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
              </ul>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>{t('ai.agent.evidence')}</CardTitle>
              <CardDescription>{t('ai.agent.evidenceDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {plan.evidence.map((evidence) => {
                const contextAgeSeconds = Math.floor((Date.now() - run.contextObservedAt) / 1000);
                const stale = evidence.source === 'context'
                  && contextAgeSeconds >= evidence.maxAgeSeconds;
                return (
                  <div key={evidence.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{evidence.description}</div>
                      <div className="text-xs text-muted-foreground">
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
            </CardContent>
          </Card>
        </>
      )}

      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>{t('ai.agent.safetyTitle')}</AlertTitle>
        <AlertDescription>{t('ai.agent.safetyDescription')}</AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground">{t('ai.agent.steps')}</div>
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
          <Badge variant={run.phase === 'error' ? 'destructive' : 'outline'}>
            {t(`ai.agent.phase.${run.phase}` as LocaleKey)}
          </Badge>
        </div>
      </div>

      {run.error && (
        <Alert variant="destructive">
          <XCircleIcon />
          <AlertTitle>{t('ai.agent.failed')}</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}

      {run.steps.map((step, index) => (
        <Card key={step.id} size="sm">
          <CardHeader>
            <CardTitle>
              {index + 1}. {step.title === 'terminal.getContext'
                ? t('ai.agent.tool.context')
                : step.title === 'remoteHealth.getSnapshotContext'
                  ? t('ai.agent.tool.remoteHealth')
                  : step.title === 'diagnosticAgent.plan'
                    ? t('ai.agent.tool.plan')
                    : step.title}
            </CardTitle>
            {step.description && <CardDescription>{step.description}</CardDescription>}
            <CardAction>
              <Badge variant={step.status === 'failed' ? 'destructive' : 'secondary'}>
                {statusIcon(step)}
                {t(`ai.agent.stepStatus.${step.status}` as LocaleKey)}
              </Badge>
            </CardAction>
          </CardHeader>
          {step.kind === 'command' && step.command && step.risk && (
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Badge variant={riskVariant(step.risk)}>
                  {t(`runbook.risk.${step.risk}` as LocaleKey)}
                </Badge>
                {step.evidenceIds?.map((evidenceId) => (
                  <Badge key={evidenceId} variant="outline">{evidenceId}</Badge>
                ))}
              </div>
              <code className="break-all rounded-md bg-muted p-2 text-xs text-foreground">
                {step.command}
              </code>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>{t('runbook.impact')}: {step.impact}</span>
                <span>{t('runbook.rollback')}: {step.rollback}</span>
                <span>{t('runbook.timeout')}: {step.timeoutSeconds}s</span>
              </div>
            </CardContent>
          )}
        </Card>
      ))}

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

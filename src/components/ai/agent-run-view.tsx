import React from 'react';
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotDashedIcon,
  FilePenLineIcon,
  InfoIcon,
  ListChecksIcon,
  LockKeyholeIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
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
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type {
  AgentRun,
  AgentRunPhase,
  AgentRunStep,
  DiagnosticAgentPlanStep,
} from '@/types/ai';
import { MessageScroller } from './chat-primitives';

type BadgeVariant = 'default' | 'outline' | 'secondary' | 'destructive';
type StageState = 'complete' | 'active' | 'pending' | 'failed';

function phaseVariant(phase: AgentRunPhase): BadgeVariant {
  if (phase === 'error') return 'destructive';
  if (phase === 'awaitingReview' || phase === 'handedOff') return 'default';
  return 'secondary';
}

function riskVariant(risk: DiagnosticAgentPlanStep['risk']): BadgeVariant {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'stateChange') return 'secondary';
  return 'outline';
}

function stageVariant(state: StageState): BadgeVariant {
  if (state === 'failed') return 'destructive';
  if (state === 'active') return 'default';
  if (state === 'complete') return 'secondary';
  return 'outline';
}

function runStages(run: AgentRun): [StageState, StageState, StageState] {
  const interrupted = run.phase === 'error' || run.phase === 'cancelled';
  const planReady = Boolean(run.plan);
  return [
    'complete',
    interrupted ? 'failed' : planReady ? 'complete' : 'active',
    run.phase === 'handedOff'
      ? 'complete'
      : run.phase === 'awaitingReview'
        ? 'active'
        : 'pending',
  ];
}

function StepStatusIcon({ status }: { status: AgentRunStep['status'] }): React.ReactNode {
  if (status === 'running') return <Spinner data-icon="inline-start" />;
  if (status === 'completed') return <CheckCircle2Icon data-icon="inline-start" />;
  if (status === 'informational') return <InfoIcon data-icon="inline-start" />;
  return <XCircleIcon data-icon="inline-start" />;
}

const AgentEmptyState: React.FC = () => {
  const { t } = useI18n();
  const stages = [
    {
      icon: ScanSearchIcon,
      title: t('ai.agent.emptyStage.observe'),
      description: t('ai.agent.emptyStage.observeHint'),
    },
    {
      icon: SparklesIcon,
      title: t('ai.agent.emptyStage.reason'),
      description: t('ai.agent.emptyStage.reasonHint'),
    },
    {
      icon: ListChecksIcon,
      title: t('ai.agent.emptyStage.review'),
      description: t('ai.agent.emptyStage.reviewHint'),
    },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <EmptyState
        className="min-h-full justify-start px-5 py-6"
        icon={<ScanSearchIcon />}
        title={t('ai.agent.emptyTitle')}
        description={t('ai.agent.empty')}
        action={(
          <div className="flex w-full max-w-md flex-col gap-3 pt-2 text-left">
            <Alert>
              <LockKeyholeIcon />
              <AlertTitle>{t('ai.agent.emptyBoundary')}</AlertTitle>
              <AlertDescription>{t('ai.agent.emptyBoundaryHint')}</AlertDescription>
            </Alert>
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t('ai.agent.emptyFlow')}</CardTitle>
                <CardDescription>{t('ai.agent.emptyFlowHint')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {stages.map(({ icon: Icon, title, description }, index) => (
                  <React.Fragment key={title}>
                    {index > 0 && <Separator />}
                    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3">
                      <Badge variant="secondary" className="size-7 rounded-full p-0">
                        <Icon />
                      </Badge>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">{title}</span>
                        <span className="text-xs leading-5 text-muted-foreground">{description}</span>
                      </div>
                    </div>
                  </React.Fragment>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      />
    </div>
  );
};

const DiagnosticStageRail: React.FC<{ run: AgentRun }> = ({ run }) => {
  const { t } = useI18n();
  const states = runStages(run);
  const stages = [
    { label: t('ai.agent.stage.context'), icon: ServerIcon },
    { label: t('ai.agent.stage.analysis'), icon: SparklesIcon },
    { label: t('ai.agent.stage.review'), icon: FilePenLineIcon },
  ];

  return (
    <div className="flex items-center gap-2" aria-label={t('ai.agent.progressLabel')}>
      {stages.map(({ label, icon: Icon }, index) => (
        <React.Fragment key={label}>
          {index > 0 && <Separator className="min-w-2 flex-1" />}
          <Badge
            variant={stageVariant(states[index])}
            aria-current={states[index] === 'active' ? 'step' : undefined}
          >
            {states[index] === 'complete'
              ? <CheckCircle2Icon data-icon="inline-start" />
              : states[index] === 'failed'
                ? <XCircleIcon data-icon="inline-start" />
                : <Icon data-icon="inline-start" />}
            {label}
          </Badge>
        </React.Fragment>
      ))}
    </div>
  );
};

const PlanningActivity: React.FC<{
  run: AgentRun;
  onCancel: () => void;
  onRetry: () => void;
}> = ({ run, onCancel, onRetry }) => {
  const { t } = useI18n();
  const canRetry = run.phase === 'error' || run.phase === 'cancelled';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{canRetry ? t('ai.agent.interruptedTitle') : t('ai.agent.analysisTitle')}</CardTitle>
        <CardDescription>
          {canRetry ? t('ai.agent.interruptedHint') : t('ai.agent.planningHint')}
        </CardDescription>
        <CardAction>
          <Badge variant={canRetry ? 'destructive' : 'secondary'}>
            {!canRetry && <Spinner data-icon="inline-start" />}
            {t(`ai.agent.phase.${run.phase}` as LocaleKey)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {run.steps.map((step, index) => (
          <React.Fragment key={step.id}>
            {index > 0 && <Separator />}
            <div
              className="flex items-start gap-3 py-2"
              aria-current={step.status === 'running' ? 'step' : undefined}
            >
              <Badge
                variant={step.status === 'failed'
                  ? 'destructive'
                  : step.status === 'running'
                    ? 'default'
                    : 'secondary'}
                className="size-7 rounded-full p-0"
              >
                <StepStatusIcon status={step.status} />
              </Badge>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{
                  step.title === 'terminal.getContext'
                    ? t('ai.agent.tool.context')
                    : step.title === 'remoteHealth.getSnapshotContext'
                      ? t('ai.agent.tool.remoteHealth')
                      : t('ai.agent.tool.plan')
                }</span>
                {step.description && (
                  <span className="text-xs leading-5 text-muted-foreground">{step.description}</span>
                )}
              </div>
              <Badge variant="outline">
                {t(`ai.agent.stepStatus.${step.status}` as LocaleKey)}
              </Badge>
            </div>
          </React.Fragment>
        ))}
      </CardContent>
      <CardFooter className="justify-end">
        {canRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCcwIcon data-icon="inline-start" />
            {t('ai.agent.retry')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <SquareIcon data-icon="inline-start" />
            {t('ai.agent.stopRun')}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
};

const EvidenceCard: React.FC<{ run: AgentRun }> = ({ run }) => {
  const { t } = useI18n();
  const plan = run.plan;
  if (!plan) return null;

  const contextAgeSeconds = Math.floor((Date.now() - run.contextObservedAt) / 1000);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('ai.agent.evidence')}</CardTitle>
        <CardDescription>{t('ai.agent.evidenceDescription')}</CardDescription>
        <CardAction>
          <Badge variant="outline">{plan.evidence.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {plan.evidence.map((evidence, index) => {
          const stale = evidence.source === 'context'
            && contextAgeSeconds >= evidence.maxAgeSeconds;
          return (
            <React.Fragment key={evidence.id}>
              {index > 0 && <Separator />}
              <div className="flex items-start gap-3 py-2">
                <Badge
                  variant={stale
                    ? 'destructive'
                    : evidence.source === 'context'
                      ? 'secondary'
                      : 'outline'}
                  className="size-7 rounded-full p-0"
                >
                  {stale
                    ? <XCircleIcon />
                    : evidence.source === 'context'
                      ? <CheckCircle2Icon />
                      : <CircleDotDashedIcon />}
                </Badge>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">{evidence.description}</span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {evidence.source === 'context'
                      ? `${run.contextSource === 'remoteHealth'
                        ? t('ai.agent.tool.remoteHealth')
                        : t('ai.agent.tool.context')} · ${new Date(run.contextObservedAt).toLocaleString()}`
                      : `${t('ai.agent.evidenceFromStep')} ${evidence.sourceStepId}`}
                    {' · '}{t('ai.agent.evidenceMaxAge', { seconds: evidence.maxAgeSeconds })}
                  </span>
                </div>
                <Badge variant={stale
                  ? 'destructive'
                  : evidence.source === 'context'
                    ? 'secondary'
                    : 'outline'}>
                  {stale
                    ? t('ai.agent.evidenceStale')
                    : evidence.source === 'context'
                      ? t('ai.agent.evidenceAttached')
                      : t('ai.agent.evidencePending')}
                </Badge>
              </div>
            </React.Fragment>
          );
        })}
      </CardContent>
    </Card>
  );
};

const PlanStep: React.FC<{
  step: AgentRunStep;
  index: number;
}> = ({ step, index }) => {
  const { t } = useI18n();
  if (step.kind !== 'command' || !step.command || !step.risk) return null;

  return (
    <Collapsible defaultOpen={step.risk !== 'readOnly'} className="flex flex-col gap-3 py-3">
      <div className="flex items-start gap-3">
        <Badge variant="secondary" className="size-7 rounded-full p-0">{index + 1}</Badge>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{step.title}</span>
              {step.description && (
                <span className="text-xs leading-5 text-muted-foreground">{step.description}</span>
              )}
            </div>
            <Badge variant={riskVariant(step.risk)}>
              {t(`runbook.risk.${step.risk}` as LocaleKey)}
            </Badge>
          </div>
          <code className="break-all rounded-lg bg-muted p-3 text-xs leading-5 text-foreground">
            {step.command}
          </code>
          <div className="flex flex-wrap gap-1.5">
            {step.evidenceIds?.map((evidenceId) => (
              <Badge key={evidenceId} variant="outline">{evidenceId}</Badge>
            ))}
          </div>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="xs" className="w-full justify-between" />}
          >
            {t('ai.agent.stepDetails')}
            <ChevronDownIcon data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="grid gap-2 rounded-lg bg-muted p-3 text-xs leading-5">
              <div>
                <dt className="font-medium text-foreground">{t('runbook.impact')}</dt>
                <dd className="text-muted-foreground">{step.impact}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">{t('runbook.rollback')}</dt>
                <dd className="text-muted-foreground">{step.rollback}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="font-medium text-foreground">{t('runbook.timeout')}</dt>
                <dd className="text-muted-foreground">{step.timeoutSeconds}s</dd>
              </div>
            </dl>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
};

const PlanPathCard: React.FC<{ run: AgentRun }> = ({ run }) => {
  const { t } = useI18n();
  const commandSteps = run.steps.filter((step) => step.kind === 'command');

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('ai.agent.path')}</CardTitle>
        <CardDescription>{t('ai.agent.pathHint')}</CardDescription>
        <CardAction>
          <Badge variant="secondary">{t('ai.agent.stepCount', { count: commandSteps.length })}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col">
        {commandSteps.map((step, index) => (
          <React.Fragment key={step.id}>
            {index > 0 && <Separator />}
            <PlanStep step={step} index={index} />
          </React.Fragment>
        ))}
      </CardContent>
    </Card>
  );
};

const PlanOverviewCard: React.FC<{ run: AgentRun }> = ({ run }) => {
  const { t } = useI18n();
  const plan = run.plan;
  if (!plan) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ai.agent.summary')}</CardTitle>
        <CardDescription>{plan.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground">{t('ai.agent.objective')}</dt>
            <dd className="text-sm leading-5 text-foreground">{plan.objective}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground">{t('ai.agent.target')}</dt>
            <dd className="text-sm leading-5 text-foreground">{plan.target}</dd>
          </div>
        </dl>
        {plan.assumptions.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger
              render={<Button variant="outline" size="sm" className="w-full justify-between" />}
            >
              {t('ai.agent.assumptionCount', { count: plan.assumptions.length })}
              <ChevronDownIcon data-icon="inline-end" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <ul className="flex list-disc flex-col gap-1 pl-5 text-xs leading-5 text-muted-foreground">
                {plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
};

export const AgentRunView: React.FC<{
  run?: AgentRun;
  onCancel: () => void;
  onRetry: () => void;
  onReviewRunbook: () => void;
}> = ({ run, onCancel, onRetry, onReviewRunbook }) => {
  const { t } = useI18n();

  if (!run) return <AgentEmptyState />;

  const plan = run.plan;
  const planning = run.phase === 'planning';

  return (
    <MessageScroller
      className="flex-1"
      followKey={`${run.phase}:${run.steps.length}:${run.responseText.length}`}
      ariaLabel={t('ai.agent.runLog')}
    >
      <Card>
        <CardHeader>
          <CardTitle>{run.goal}</CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <ServerIcon />
            <span className="truncate">{run.contextLabel}</span>
            <span aria-hidden>·</span>
            <span>{new Date(run.contextObservedAt).toLocaleTimeString()}</span>
          </CardDescription>
          <CardAction>
            <Badge variant={phaseVariant(run.phase)}>
              {planning && <Spinner data-icon="inline-start" />}
              {t(`ai.agent.phase.${run.phase}` as LocaleKey)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DiagnosticStageRail run={run} />
        </CardContent>
      </Card>

      {run.error && (
        <Alert variant="destructive">
          <XCircleIcon />
          <AlertTitle>{t('ai.agent.failed')}</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}

      {!plan ? (
        <PlanningActivity run={run} onCancel={onCancel} onRetry={onRetry} />
      ) : (
        <>
          <PlanOverviewCard run={run} />
          <EvidenceCard run={run} />
          <PlanPathCard run={run} />
        </>
      )}

      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>{t('ai.agent.safetyTitle')}</AlertTitle>
        <AlertDescription>{t('ai.agent.safetyDescription')}</AlertDescription>
      </Alert>

      {plan && ['awaitingReview', 'handedOff'].includes(run.phase) && (
        <Card>
          <CardHeader>
            <CardTitle>{run.phase === 'handedOff'
              ? t('ai.agent.handedOffTitle')
              : t('ai.agent.reviewRunbookTitle')}</CardTitle>
            <CardDescription>{run.phase === 'handedOff'
              ? t('ai.agent.handedOffDescription')
              : t('ai.agent.reviewRunbookDescription')}</CardDescription>
          </CardHeader>
          <CardFooter className="flex-col items-stretch gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockKeyholeIcon className="size-3.5" />
              {t('ai.agent.reviewBoundary')}
            </div>
            <Button className="w-full" onClick={onReviewRunbook}>
              {run.phase === 'handedOff'
                ? <ArrowRightIcon data-icon="inline-start" />
                : <FilePenLineIcon data-icon="inline-start" />}
              {t('ai.agent.reviewRunbook')}
            </Button>
          </CardFooter>
        </Card>
      )}
    </MessageScroller>
  );
};

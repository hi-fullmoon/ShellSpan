import { useState } from 'react';
import { ActivityIcon, ChevronRightIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { PanelEmptyState } from '@/components/ui/empty-state';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import type {
  AgentActivityAgent,
  AgentActivityProjection,
  AgentSessionRuntimeStatus,
  AgentSessionToolStatus,
} from '@/types/agent-session';

function runtimeStatusVariant(
  status: AgentSessionRuntimeStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'running' || status === 'waiting') return 'secondary';
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  return 'outline';
}

function AgentTree({
  agents,
  parentSessionId,
  depth = 0,
  visited = new Set<string>(),
}: {
  readonly agents: readonly AgentActivityAgent[];
  readonly parentSessionId: string | undefined;
  readonly depth?: number;
  readonly visited?: ReadonlySet<string>;
}): React.ReactNode {
  const { t } = useI18n();
  const children = agents.filter((agent) => agent.parentSessionId === parentSessionId);
  if (children.length === 0) return null;
  return children.map((agent) => {
    if (visited.has(agent.sessionId)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(agent.sessionId);
    return (
      <div key={agent.sessionId} className="flex flex-col gap-2" style={{ paddingInlineStart: depth * 12 }}>
        <div className="flex items-start justify-between gap-3 rounded-md border p-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium">{agent.role} · {agent.sessionId}</span>
            <span className="text-xs text-muted-foreground">
              {agent.continuable ? t('agent.session.agent.continuable') : t('agent.session.agent.oneShot')}
              {agent.targetScope?.[0] ? ` · ${agent.targetScope[0].targetId}` : ''}
              {agent.detached ? ` · ${t('agent.session.agent.released')}` : ''}
            </span>
            {agent.summary && <span className="text-xs text-muted-foreground">{agent.summary}</span>}
          </div>
          <Badge variant={runtimeStatusVariant(agent.status)}>
            {t(runtimeStatusLabel(agent.status))}
          </Badge>
        </div>
        <AgentTree
          agents={agents}
          parentSessionId={agent.sessionId}
          depth={depth + 1}
          visited={nextVisited}
        />
      </div>
    );
  });
}

function FleetTargetMatrix({ projection }: { readonly projection: AgentActivityProjection }): React.ReactNode {
  const { t } = useI18n();
  const targets = projection.fleet?.targets ?? [];
  if (targets.length === 0) {
    return <span className="text-muted-foreground">{t('agent.session.fleet.empty')}</span>;
  }
  return (
    <div className="grid gap-px overflow-hidden rounded-md border bg-border text-sm" data-testid="agent-fleet-matrix">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
        <span>{t('agent.session.fleet.target')}</span>
        <span>{t('agent.session.fleet.waveLabel')}</span>
        <span>{t('agent.session.fleet.state')}</span>
      </div>
      {targets.map((target) => (
        <div key={target.targetId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 bg-background px-2 py-1.5">
          <div className="min-w-0">
            <div className="truncate">{target.targetId}</div>
            <div className="truncate text-xs text-muted-foreground">
              {t('agent.session.fleet.targetCounts', {
                agents: target.childSessionIds?.length ?? 0,
                evidence: target.evidenceRefs?.length ?? 0,
              })}
            </div>
          </div>
          <span className="text-muted-foreground">{target.wave}</span>
          <Badge variant={target.state === 'failed' ? 'destructive' : target.state === 'completed' ? 'default' : 'secondary'}>
            {target.state}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function toolStatusVariant(
  status: AgentSessionToolStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'running' || status === 'awaitingApproval') return 'secondary';
  if (status === 'failed' || status === 'timedOut' || status === 'cancelled') return 'destructive';
  return 'outline';
}

function runtimeStatusLabel(status: AgentSessionRuntimeStatus): LocaleKey {
  switch (status) {
    case 'idle': return 'agent.session.status.idle';
    case 'waiting': return 'agent.session.status.waiting';
    case 'running': return 'agent.outcome.running';
    case 'completed': return 'agent.outcome.completed';
    case 'cancelled': return 'agent.outcome.cancelled';
    case 'failed': return 'agent.outcome.failed';
  }
}

function durationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function ActivitySection({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
}): React.ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const { t } = useI18n();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border py-1">
      <CollapsibleTrigger
        render={(
          <Button
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start px-1 py-2 text-left"
            aria-label={open
              ? t('agent.session.section.collapse', { section: title })
              : t('agent.session.section.expand', { section: title })}
          />
        )}
      >
        <ChevronRightIcon data-icon="inline-start" className={cn('transition-transform', open && 'rotate-90')} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        </span>
      </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="min-w-0 pb-3 pl-7 pr-1">{children}</div>
        </CollapsibleContent>
    </Collapsible>
  );
}

function ActivityTimeline({ projection }: { readonly projection: AgentActivityProjection }): React.ReactNode {
  const { t } = useI18n();
  if (projection.turns.length === 0) {
    return (
      <PanelEmptyState
        icon={<ActivityIcon />}
        title={t('agent.session.activity.emptyTitle')}
        description={t('agent.session.activity.emptyDescription')}
      />
    );
  }

  return projection.turns.map((turn) => (
    <section key={turn.id} className="flex min-w-0 flex-col gap-3 border-b border-border py-3" data-agent-turn-id={turn.id}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">{t('agent.session.turn', { number: turn.index })}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {[durationLabel(turn.durationMs), turn.endReason].filter(Boolean).join(' · ')
              || t('agent.session.timeline.inProgress')}
          </p>
        </div>
        <Badge variant={runtimeStatusVariant(turn.status)}>{t(runtimeStatusLabel(turn.status))}</Badge>
      </div>
      <div className="flex flex-col gap-3 pl-2">
        {turn.steps.map((step, index) => (
          <div key={step.id} className="flex flex-col gap-2" data-agent-step-id={step.id}>
            {index > 0 && <Separator />}
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{t('agent.session.step', { number: step.index })}</span>
                <span className="text-xs text-muted-foreground">
                  {step.request
                    ? [
                        step.request.model || step.request.providerId,
                        durationLabel(step.durationMs),
                        step.request.inputTokens !== undefined
                          ? t('agent.session.tokens', { count: step.request.inputTokens })
                          : undefined,
                      ].filter(Boolean).join(' · ')
                    : (durationLabel(step.durationMs) ?? t('agent.session.model.pending'))}
                </span>
              </div>
              <Badge variant={runtimeStatusVariant(step.status)}>
                {t(runtimeStatusLabel(step.status))}
              </Badge>
            </div>
            {step.tools.length > 0 && (
              <div className="flex flex-col gap-1.5 pl-3">
                {step.tools.map((tool) => (
                  <div key={tool.callId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{tool.title}</span>
                    <Badge variant={toolStatusVariant(tool.status)}>
                      {t(`agent.status.${tool.status}` as LocaleKey)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  ));
}

export function AgentActivityView({
  projection,
}: {
  readonly projection: AgentActivityProjection;
}): React.ReactNode {
  const { t } = useI18n();
  const completedPlanSteps = projection.plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const runningAgents = projection.agents.filter((agent) => agent.status === 'running').length;
  const settledAgents = projection.agents.filter((agent) => (
    agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled'
  )).length;

  return (
    <ScrollArea className="min-h-0 flex-1" aria-label={t('agent.session.activity')}>
      <ScrollAreaContent className="flex min-w-0 flex-col px-3 pb-4 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5">
        <section className="flex min-w-0 items-start justify-between gap-3 border-b border-border py-3">
          <div className="min-w-0">
            <h3 className="font-medium">{t('agent.session.activity.statusTitle')}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {projection.statusReason ?? t('agent.session.activity.statusDescription')}
            </p>
          </div>
          <Badge variant={runtimeStatusVariant(projection.status)}>{t(runtimeStatusLabel(projection.status))}</Badge>
        </section>
        <ActivityTimeline projection={projection} />

        <ActivitySection
          title={t('agent.session.section.plan')}
          description={projection.plan
            ? t('agent.session.plan.summary', {
                completed: completedPlanSteps,
                total: projection.plan.steps.length,
              })
            : t('agent.session.plan.empty')}
          defaultOpen={Boolean(projection.plan)}
        >
          <div className="flex flex-col gap-2">
            {projection.plan?.steps.map((step) => (
              <div key={step.id} className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{step.title}</span>
                  {step.detail && <span className="text-xs text-muted-foreground">{step.detail}</span>}
                </div>
                <Badge variant={step.status === 'completed' ? 'default' : 'outline'}>
                  {t(`agent.session.plan.status.${step.status}` as LocaleKey)}
                </Badge>
              </div>
            )) ?? <span className="text-muted-foreground">{t('agent.session.plan.empty')}</span>}
          </div>
        </ActivitySection>

        <ActivitySection
          title={t('agent.session.section.context')}
          description={projection.context.inputTokens !== undefined
            ? t('agent.session.context.summary', {
                used: projection.context.inputTokens,
                limit: projection.context.contextWindow ?? '—',
                generation: projection.context.surfaceGeneration,
              })
            : t('agent.session.context.empty')}
        >
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {t('agent.session.context.compactions', { count: projection.context.compactionCount })}
            </Badge>
            <Badge variant="secondary">
              {t('agent.session.context.artifacts', { count: projection.context.artifacts.length })}
            </Badge>
            <Badge variant="secondary">
              {t('agent.session.context.evidence', { count: projection.evidenceCount })}
            </Badge>
          </div>
        </ActivitySection>

        <ActivitySection
          title={t('agent.session.section.agents')}
          description={t('agent.session.agents.summary', {
            running: runningAgents,
            settled: settledAgents,
          })}
          defaultOpen={projection.agents.some((agent) => agent.parentSessionId !== undefined)}
        >
          <div className="flex flex-col gap-2">
            <AgentTree agents={projection.agents} parentSessionId={undefined} />
          </div>
        </ActivitySection>

        <ActivitySection
          title={t('agent.session.section.recovery')}
          description={projection.recovery.summary
            ?? t(`agent.session.recovery.${projection.recovery.status}` as LocaleKey)}
        >
          <Badge variant={projection.recovery.status === 'required' ? 'destructive' : 'outline'}>
            {t(`agent.session.recovery.${projection.recovery.status}` as LocaleKey)}
          </Badge>
        </ActivitySection>

        <ActivitySection
          title={t('agent.session.section.fleet')}
          description={projection.fleet
            ? t('agent.session.fleet.summary', {
                wave: projection.fleet.wave,
                waves: projection.fleet.totalWaves,
                completed: projection.fleet.targetsCompleted,
                total: projection.fleet.targetsTotal,
              })
            : t('agent.session.fleet.empty')}
          defaultOpen={Boolean(projection.fleet)}
        >
          {projection.fleet ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">
                {t('agent.session.fleet.wave', {
                  wave: projection.fleet.wave,
                  total: projection.fleet.totalWaves,
                })}
              </Badge>
              <Badge variant="secondary">
                {t('agent.session.fleet.targets', {
                  completed: projection.fleet.targetsCompleted,
                  total: projection.fleet.targetsTotal,
                })}
              </Badge>
              </div>
              <FleetTargetMatrix projection={projection} />
            </div>
          ) : <span className="text-muted-foreground">{t('agent.session.fleet.empty')}</span>}
        </ActivitySection>
      </ScrollAreaContent>
    </ScrollArea>
  );
}

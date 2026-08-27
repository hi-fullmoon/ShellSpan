import { useEffect, useState } from 'react';
import {
  BrainCircuitIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CircleXIcon,
  PauseIcon,
  PlayIcon,
  ShieldCheckIcon,
  SquareIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { isAgentRunTerminalStateV1 } from '@/lib/agent-state';
import type { LocaleKey } from '@/locales';
import type { AgentRunSnapshotV1, AgentRunStateV1 } from '@/types/agent';

export type AgentPendingAction = 'pause' | 'resume' | 'stop' | 'sendMessage' | undefined;
type BadgeVariant = 'default' | 'outline' | 'secondary' | 'destructive';

const stateIcon = {
  created: BrainCircuitIcon,
  collectingContext: BrainCircuitIcon,
  thinking: BrainCircuitIcon,
  validatingTool: BrainCircuitIcon,
  executingTool: BrainCircuitIcon,
  observing: BrainCircuitIcon,
  awaitingUser: CircleAlertIcon,
  pausing: CirclePauseIcon,
  paused: CirclePauseIcon,
  cancelling: SquareIcon,
  completed: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: SquareIcon,
  blocked: CircleXIcon,
} satisfies Record<AgentRunStateV1, React.ComponentType>;

function stateVariant(state: AgentRunStateV1): BadgeVariant {
  if (state === 'failed' || state === 'blocked') return 'destructive';
  if (state === 'completed') return 'default';
  if (state === 'cancelled' || state === 'paused') return 'outline';
  return 'secondary';
}

function budgetVariant(used: number, max: number): BadgeVariant {
  if (max === 0 || used >= max) return 'destructive';
  if (used / max >= 0.8) return 'secondary';
  return 'outline';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function AgentRunHeader({
  snapshot,
  snapshotReceivedAt,
  currentProfileId,
  resyncing,
  pendingAction,
  onPause,
  onResume,
  onStop,
}: {
  snapshot: AgentRunSnapshotV1;
  snapshotReceivedAt?: number;
  currentProfileId?: string;
  resyncing: boolean;
  pendingAction: AgentPendingAction;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const terminal = isAgentRunTerminalStateV1(snapshot.state);
  const ticking = !terminal && snapshot.state !== 'paused';

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const sinceSnapshot = ticking && snapshotReceivedAt
    ? Math.max(0, Date.now() - snapshotReceivedAt)
    : 0;
  const elapsed = snapshot.budgets.usage.elapsedMillis + sinceSnapshot;
  const Icon = stateIcon[snapshot.state];
  const profileChanged = Boolean(
    currentProfileId && currentProfileId !== snapshot.target.profileId,
  );
  const canPause = !terminal
    && snapshot.state !== 'paused'
    && snapshot.state !== 'pausing'
    && snapshot.state !== 'cancelling';
  const canResume = snapshot.state === 'paused';
  const canStop = !terminal && snapshot.state !== 'cancelling';

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-sm font-medium text-foreground">
            {snapshot.target.profileLabel} · {snapshot.target.username}@{snapshot.target.host}:{snapshot.target.port}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot.provider.model} · {snapshot.policy.policyVersion}
          </p>
        </div>
        <Badge variant="secondary">
          <ShieldCheckIcon data-icon="inline-start" />
          {t('ai.dynamicAgent.readOnly')}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={stateVariant(snapshot.state)}>
          {['thinking', 'validatingTool', 'executingTool', 'observing', 'pausing', 'cancelling']
            .includes(snapshot.state)
            ? <Spinner data-icon="inline-start" />
            : <Icon data-icon="inline-start" />}
          {t(`ai.dynamicAgent.state.${snapshot.state}` as LocaleKey)}
        </Badge>
        <Badge variant="outline">
          {t('ai.dynamicAgent.budget.duration', { duration: formatDuration(elapsed) })}
        </Badge>
        <Badge variant={budgetVariant(
          snapshot.budgets.usage.toolCallsUsed,
          snapshot.budgets.policy.maxToolCalls,
        )}>
          {t('ai.dynamicAgent.budget.toolCalls', {
            used: snapshot.budgets.usage.toolCallsUsed,
            max: snapshot.budgets.policy.maxToolCalls,
          })}
        </Badge>
        <Badge variant={budgetVariant(
          snapshot.budgets.usage.modelTurnsUsed,
          snapshot.budgets.policy.maxModelTurns,
        )}>
          {t('ai.dynamicAgent.budget.modelTurns', {
            used: snapshot.budgets.usage.modelTurnsUsed,
            max: snapshot.budgets.policy.maxModelTurns,
          })}
        </Badge>
        {resyncing && (
          <Badge variant="secondary">
            <Spinner data-icon="inline-start" />
            {t('ai.dynamicAgent.resyncing')}
          </Badge>
        )}
      </div>

      {profileChanged && (
        <p className="text-xs text-muted-foreground">
          {t('ai.dynamicAgent.frozenTargetHint')}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {canResume ? (
          <Button size="sm" variant="secondary" onClick={onResume} disabled={Boolean(pendingAction)}>
            {pendingAction === 'resume'
              ? <Spinner data-icon="inline-start" />
              : <PlayIcon data-icon="inline-start" />}
            {t('ai.dynamicAgent.resume')}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={onPause} disabled={!canPause || Boolean(pendingAction)}>
            {pendingAction === 'pause'
              ? <Spinner data-icon="inline-start" />
              : <PauseIcon data-icon="inline-start" />}
            {t('ai.dynamicAgent.pause')}
          </Button>
        )}
        <Button size="sm" variant="destructive" onClick={onStop} disabled={!canStop || Boolean(pendingAction)}>
          {pendingAction === 'stop'
            ? <Spinner data-icon="inline-start" />
            : <SquareIcon data-icon="inline-start" />}
          {t('ai.dynamicAgent.stop')}
        </Button>
      </div>
    </header>
  );
}

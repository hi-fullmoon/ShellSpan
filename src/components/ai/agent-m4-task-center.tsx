import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRightIcon,
  ClockIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  XCircleIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
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
import { Separator } from '@/components/ui/separator';
import {
  invokeAgentV3ConfigureOperator,
  invokeAgentV3ListAuditEvents,
  invokeAgentV3ListOperatorGrants,
  invokeAgentV3ListTasks,
  invokeAgentV3OperatorPolicy,
  invokeAgentV3RebindRecoverySession,
  invokeAgentV3ReconcileTask,
  invokeAgentV3RecoveryStatus,
  invokeAgentV3RevokeOperator,
  invokeAgentV3RolloutPolicy,
  isTauriRuntime,
} from '@/lib/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { cn } from '@/lib/utils';
import type {
  AgentEffectKindV3,
  AgentOperatorGrantV3,
  AgentOperatorPolicyV3,
  AgentRecoveryStoreStatusV3,
  AgentTaskSnapshotV3,
  AgentToolNameV3,
} from '@/types/agent-v3';

function stateVariant(
  state: AgentTaskSnapshotV3['state'],
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'completed') return 'default';
  if (state === 'active') return 'secondary';
  if (state === 'cancelled') return 'outline';
  return 'destructive';
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function scopeForTask(task: AgentTaskSnapshotV3): {
  targetIds: string[];
  toolNames: AgentToolNameV3[];
  effects: AgentEffectKindV3[];
  pathPrefixes: string[];
} | undefined {
  const plan = task.plan;
  if (!plan || plan.steps.length === 0) return undefined;
  const targetIds = [...new Set(plan.steps.flatMap((step) => step.targetIds))];
  const toolNames = [...new Set(plan.steps.flatMap((step) => step.requiredTools))];
  const effects = [...new Set(plan.steps.map((step) => step.expectedEffect))];
  const pathPrefixes = task.request.targets.flatMap((target) => {
    if (!targetIds.includes(target.targetId)) return [];
    if (target.kind === 'local' && target.cwd) return [target.cwd];
    if (target.kind === 'remote' && target.rootPath) return [target.rootPath];
    return [];
  });
  return { targetIds, toolNames, effects, pathPrefixes };
}

function TaskCard({
  task,
  busy,
  activeSessionId,
  onRebind,
  onReconcile,
}: {
  readonly task: AgentTaskSnapshotV3;
  readonly busy?: string;
  readonly activeSessionId: string | null;
  readonly onRebind: (taskId: string, sessionId: string) => void;
  readonly onReconcile: (taskId: string, continueTask: boolean) => void;
}): React.ReactNode {
  const recovery = task.recovery;
  const progress = recovery.progressTotal > 0
    ? `${recovery.progressCompleted}/${recovery.progressTotal}`
    : 'not planned';
  const effects = [...new Set(recovery.calls.map((call) => call.effect))];
  const sensitivePathCount = recovery.calls.reduce(
    (total, call) => total + call.sensitivePathCount,
    0,
  );
  const networkDestinationCount = new Set(
    recovery.calls.flatMap((call) => call.networkDestinations.map(
      (destination) => `${destination.protocol}://${destination.host}:${destination.port}`,
    )),
  ).size;

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate" title={task.request.goal}>{task.request.goal}</CardTitle>
            <CardDescription>
              Started {formatTime(task.createdAtUnixMs)} · updated {formatTime(task.updatedAtUnixMs)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={stateVariant(task.state)}>{task.state}</Badge>
            <Badge variant="outline">{recovery.phase}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2 @xl:grid-cols-2">
          <div>
            <div className="text-muted-foreground">Targets</div>
            <div>{task.request.targets.map((target) => target.targetId).join(', ')}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Progress</div>
            <div>{progress} · sequence {task.sequence}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Effects</div>
            <div>{effects.join(', ') || 'none recorded'}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Native notifications</div>
            <div>{task.notifications.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Recovery policy scope</div>
            <div>{sensitivePathCount} sensitive path(s) · {networkDestinationCount} network destination(s)</div>
          </div>
        </div>
        <Alert
          variant={recovery.requiresHumanAction || recovery.requiresSessionRebind ? 'warning' : 'default'}
          size="sm"
        >
          <AlertTitle>
            {recovery.disposition}
            {recovery.requiresSessionRebind ? ' · session rebind required' : ''}
          </AlertTitle>
          <AlertDescription>{recovery.recoveryAdvice}</AlertDescription>
        </Alert>
        {recovery.processes.map((process) => (
          <div key={process.processHandle} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={process.state === 'lost' ? 'destructive' : 'outline'}>
                process {process.state}
              </Badge>
              <span>{process.channel} · {process.ownerTargetId}</span>
            </div>
            <span className="text-muted-foreground">{process.recoveryAdvice}</span>
          </div>
        ))}
        {recovery.lastFailure && (
          <Alert variant="destructive" size="sm">
            <AlertTitle>Latest native failure</AlertTitle>
            <AlertDescription>{recovery.lastFailure}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      {(recovery.requiresHumanAction || recovery.requiresSessionRebind) && (
        <CardFooter className="flex flex-wrap gap-1.5">
          {recovery.requiresSessionRebind && (
            <Button
              variant="secondary"
              size="xs"
              disabled={Boolean(busy) || !activeSessionId}
              onClick={() => activeSessionId && onRebind(task.request.taskId, activeSessionId)}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {activeSessionId ? 'Rebind to active terminal' : 'Open a matching terminal to rebind'}
            </Button>
          )}
          {recovery.requiresHumanAction && (
            <>
              <Button
                variant="secondary"
                size="xs"
                disabled={Boolean(busy) || recovery.requiresSessionRebind}
                onClick={() => onReconcile(task.request.taskId, true)}
              >
                <ShieldCheckIcon data-icon="inline-start" />
                Revalidate &amp; continue
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={Boolean(busy)}
                onClick={() => onReconcile(task.request.taskId, false)}
              >
                <XCircleIcon data-icon="inline-start" />
                Cancel without replay
              </Button>
            </>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function OperatorCard({
  task,
  policy,
  grants,
  now,
  busy,
  onEnable,
  onRevoke,
}: {
  readonly task?: AgentTaskSnapshotV3;
  readonly policy?: AgentOperatorPolicyV3;
  readonly grants: readonly AgentOperatorGrantV3[];
  readonly now: number;
  readonly busy?: string;
  readonly onEnable: () => void;
  readonly onRevoke: (grantId: string) => void;
}): React.ReactNode {
  const scope = task ? scopeForTask(task) : undefined;
  const active = grants.filter((grant) => !grant.revokedAtUnixMs && grant.expiresAtUnixMs > now);
  const currentTaskHasGrant = active.some((grant) => grant.taskId === task?.request.taskId);
  const canEnable = policy?.stage === 'enabled'
    && task?.state === 'active'
    && task?.request.permissionMode === 'operator'
    && Boolean(scope)
    && !currentTaskHasGrant;

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Operator</CardTitle>
            <CardDescription>Off by default; exact task, target, tool, effect, path, and TTL scope</CardDescription>
          </div>
          <Badge variant={active.length > 0 ? 'default' : 'outline'}>
            {active.length > 0 ? 'enabled' : policy?.stage ?? 'unavailable'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {active.map((grant) => (
          <div key={grant.grantId} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <ClockIcon aria-hidden="true" />
              <span>{Math.max(0, Math.ceil((grant.expiresAtUnixMs - now) / 1000))}s remaining</span>
              <Badge variant="outline">{grant.toolNames.join(', ')}</Badge>
              <Badge variant="outline">{grant.effects.join(', ')}</Badge>
            </div>
            <span className="text-muted-foreground">
              Task {grant.taskId} · targets {grant.targetIds.join(', ')} · {grant.pathPrefixes.length} path scope(s) · elevation {grant.allowElevation ? 'allowed' : 'denied'}
            </span>
            <div>
              <Button
                variant="outline"
                size="xs"
                disabled={Boolean(busy)}
                onClick={() => onRevoke(grant.grantId)}
              >
                <ShieldOffIcon data-icon="inline-start" />
                Revoke now
              </Button>
            </div>
          </div>
        ))}
        {!currentTaskHasGrant && (
          <span className="text-muted-foreground">
            {canEnable
              ? `Ready to bind the current Rust plan: ${scope?.toolNames.join(', ')}.`
              : 'Enable the separate rollout and use an Operator task with a native plan.'}
          </span>
        )}
      </CardContent>
      <CardFooter>
        <Button size="xs" disabled={!canEnable || Boolean(busy)} onClick={onEnable}>
          <ShieldCheckIcon data-icon="inline-start" />
          Enable for 5 minutes
        </Button>
      </CardFooter>
    </Card>
  );
}

export function AgentM4TaskCenter(): React.ReactNode {
  const [tasks, setTasks] = useState<readonly AgentTaskSnapshotV3[]>([]);
  const [policy, setPolicy] = useState<AgentOperatorPolicyV3>();
  const [grants, setGrants] = useState<readonly AgentOperatorGrantV3[]>([]);
  const [storeStatus, setStoreStatus] = useState<AgentRecoveryStoreStatusV3>();
  const [auditCount, setAuditCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const latestTask = useMemo(() => tasks[tasks.length - 1], [tasks]);

  const refresh = useCallback(async () => {
    const [nextTasks, nextPolicy, nextGrants, nextStore, audit] = await Promise.all([
      invokeAgentV3ListTasks(),
      invokeAgentV3OperatorPolicy().catch(() => ({
        stage: 'disabled' as const,
        defaultEnabled: false as const,
        maximumTtlMs: 0,
        grantsSurviveRestart: false as const,
      })),
      invokeAgentV3ListOperatorGrants().catch(() => []),
      invokeAgentV3RecoveryStatus().catch(() => undefined),
      invokeAgentV3ListAuditEvents().catch(() => []),
    ]);
    setTasks(nextTasks);
    setPolicy(nextPolicy);
    setGrants(nextGrants);
    setStoreStatus(nextStore);
    setAuditCount(audit.length);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void invokeAgentV3RolloutPolicy()
      .then(async (rollout) => {
        if (rollout.stage !== 'runtime') return;
        await refresh();
        if (active) setVisible(true);
      })
      .catch(() => {
        // Agent v2 remains authoritative when the explicit v3 runtime is unavailable.
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const reconcile = useCallback(async (taskId: string, continueTask: boolean) => {
    setBusy(`reconcile:${taskId}`);
    setError(undefined);
    try {
      await invokeAgentV3ReconcileTask(taskId, continueTask);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const rebind = useCallback(async (taskId: string, sessionId: string) => {
    setBusy(`rebind:${taskId}`);
    setError(undefined);
    try {
      await invokeAgentV3RebindRecoverySession(taskId, sessionId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const enableOperator = useCallback(async () => {
    if (!latestTask) return;
    const scope = scopeForTask(latestTask);
    if (!scope) return;
    setBusy('operator:enable');
    setError(undefined);
    try {
      await invokeAgentV3ConfigureOperator({
        taskId: latestTask.request.taskId,
        targetIds: scope.targetIds,
        toolNames: scope.toolNames,
        effects: scope.effects,
        pathPrefixes: scope.pathPrefixes,
        networkDestinations: [],
        allowElevation: false,
        ttlMs: 5 * 60 * 1_000,
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [latestTask, refresh]);

  const revokeOperator = useCallback(async (grantId: string) => {
    setBusy(`operator:revoke:${grantId}`);
    setError(undefined);
    try {
      await invokeAgentV3RevokeOperator(grantId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  if (!visible) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section aria-label="Agent v3 M4 background task center" className="flex shrink-0 flex-col gap-2 px-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div>Background task center</div>
            <div className="text-muted-foreground">
              {tasks.length} Rust-owned task(s) · persistence v{storeStatus?.formatVersion ?? 1} · {auditCount} native audit event(s)
            </div>
          </div>
          <div className="flex gap-1.5">
            <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
              Details
              <ChevronRightIcon
                data-icon="inline-end"
                className={cn('transition-transform', open && 'rotate-90')}
              />
            </CollapsibleTrigger>
            <Button variant="ghost" size="xs" disabled={Boolean(busy)} onClick={() => void refresh()}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </div>
        {storeStatus?.warning && (
          <Alert variant="warning" size="sm">
            <AlertTitle>Persistence recovered safely</AlertTitle>
            <AlertDescription>{storeStatus.warning}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" size="sm">
            <AlertTitle>M4 action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <CollapsibleContent className="flex flex-col gap-2">
          <OperatorCard
            task={latestTask}
            policy={policy}
            grants={grants}
            now={now}
            busy={busy}
            onEnable={() => void enableOperator()}
            onRevoke={(grantId) => void revokeOperator(grantId)}
          />
          {tasks.length > 0 && <Separator />}
          {tasks.map((task) => (
            <TaskCard
              key={task.request.taskId}
              task={task}
              busy={busy}
              activeSessionId={activeSessionId}
              onRebind={(taskId, sessionId) => void rebind(taskId, sessionId)}
              onReconcile={(taskId, continueTask) => void reconcile(taskId, continueTask)}
            />
          ))}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

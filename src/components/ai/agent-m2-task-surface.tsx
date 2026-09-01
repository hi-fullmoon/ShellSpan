import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCwIcon, RotateCcwIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  invokeAgentV3GetTask,
  invokeAgentV3ListTasks,
  invokeAgentV3RestoreCheckpoint,
  invokeAgentV3RolloutPolicy,
  isTauriRuntime,
} from '@/lib/tauri';
import type { AgentFileCheckpointV3, AgentPlanStepV3, AgentTaskSnapshotV3 } from '@/types/agent-v3';

function stepVariant(status: AgentPlanStepV3['status']): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'inProgress') return 'secondary';
  if (status === 'blocked') return 'destructive';
  return 'outline';
}

function AgentPlanView({ task }: { readonly task: AgentTaskSnapshotV3 }): React.ReactNode {
  const plan = task.plan;
  if (!plan) return null;

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle>Plan v{plan.version}</CardTitle>
        <CardDescription>{plan.explanation ?? 'Rust-authoritative task plan'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {plan.steps.map((step) => (
          <div key={step.id} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span>{step.description}</span>
              <Badge variant={stepVariant(step.status)}>{step.status}</Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              Targets: {step.targetIds.join(', ')} · Tools: {step.requiredTools.join(', ')} · Effect: {step.expectedEffect}
            </span>
            <span className="text-xs text-muted-foreground">
              Success: {step.successCriteria.join('; ')} · Evidence: {step.evidenceRefs?.join(', ') || 'none'}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function checkpointLabel(checkpoint: AgentFileCheckpointV3): string {
  const state = checkpoint.restoredAtUnixMs ? 'restored' : 'available';
  return `${checkpoint.targetKind} · ${checkpoint.originalByteLength} bytes · ${state}`;
}

function AgentCheckpointView({
  task,
  restoring,
  onRestore,
}: {
  readonly task: AgentTaskSnapshotV3;
  readonly restoring?: string;
  readonly onRestore: (checkpoint: AgentFileCheckpointV3) => void;
}): React.ReactNode {
  if (task.checkpoints.length === 0) return null;

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle>File checkpoints</CardTitle>
        <CardDescription>Bounded recovery copies verified by SHA-256</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {task.checkpoints.map((checkpoint, index) => (
          <div key={checkpoint.checkpointId} className="flex flex-col gap-2">
            {index > 0 && <Separator />}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate" title={checkpoint.targetPath}>{checkpoint.targetPath}</div>
                <div className="text-xs text-muted-foreground">{checkpointLabel(checkpoint)}</div>
              </div>
              <Button
                variant="outline"
                size="xs"
                disabled={Boolean(restoring) || Boolean(checkpoint.restoredAtUnixMs)}
                onClick={() => onRestore(checkpoint)}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Restore
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function AgentM2TaskSurface(): React.ReactNode {
  const [tasks, setTasks] = useState<readonly AgentTaskSnapshotV3[]>([]);
  const [visible, setVisible] = useState(false);
  const [restoring, setRestoring] = useState<string>();
  const [error, setError] = useState<string>();
  const latestTask = useMemo(() => tasks[tasks.length - 1], [tasks]);

  const refresh = useCallback(async () => {
    const next = await invokeAgentV3ListTasks();
    setTasks(next);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void invokeAgentV3RolloutPolicy()
      .then(async (policy) => {
        if (policy.stage !== 'runtime') return;
        const next = await invokeAgentV3ListTasks();
        if (active) {
          setVisible(true);
          setTasks(next);
        }
      })
      .catch(() => {
        // A disabled or unavailable M2 surface stays absent; v2 remains authoritative.
      });
    return () => {
      active = false;
    };
  }, []);

  const restore = useCallback(async (checkpoint: AgentFileCheckpointV3) => {
    if (!latestTask) return;
    setRestoring(checkpoint.checkpointId);
    setError(undefined);
    try {
      await invokeAgentV3RestoreCheckpoint(latestTask.request.taskId, checkpoint.checkpointId);
      const refreshed = await invokeAgentV3GetTask(latestTask.request.taskId);
      setTasks((current) => [...current.slice(0, -1), refreshed]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(undefined);
    }
  }, [latestTask]);

  if (!visible || !latestTask || (!latestTask.plan && latestTask.checkpoints.length === 0)) return null;

  return (
    <section aria-label="Agent v3 M2 task state" className="flex shrink-0 flex-col gap-2 px-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div>Native M2 task state</div>
          <div className="text-xs text-muted-foreground">{latestTask.request.goal}</div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => void refresh()}>
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" size="sm">
          <AlertTitle>Restore failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AgentPlanView task={latestTask} />
      <AgentCheckpointView task={latestTask} restoring={restoring} onRestore={(checkpoint) => void restore(checkpoint)} />
    </section>
  );
}

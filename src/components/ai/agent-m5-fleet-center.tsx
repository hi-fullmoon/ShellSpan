import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRightIcon,
  NetworkIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  invokeAgentV3ListFleets,
  invokeAgentV3RolloutPolicy,
  isTauriRuntime,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
import type {
  AgentFleetSnapshotV3,
  AgentFleetStateV3,
  AgentFleetTargetStateV3,
} from '@/types/agent-v3';

function fleetVariant(
  state: AgentFleetStateV3,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'completed') return 'default';
  if (state === 'ready' || state === 'running') return 'secondary';
  if (state === 'cancelled') return 'outline';
  return 'destructive';
}

function targetVariant(
  state: AgentFleetTargetStateV3,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'succeeded') return 'default';
  if (state === 'running' || state === 'canary' || state === 'awaitingVerification') {
    return 'secondary';
  }
  if (state === 'failed' || state === 'blocked' || state === 'needsReconciliation') {
    return 'destructive';
  }
  return 'outline';
}

function FleetCard({ fleet }: { readonly fleet: AgentFleetSnapshotV3 }): React.ReactNode {
  const attention = fleet.failureCount > 0
    || fleet.state === 'failStopped'
    || fleet.state === 'needsReconciliation'
    || fleet.state === 'completedWithFailures';

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate" title={fleet.goal}>{fleet.goal}</CardTitle>
            <CardDescription>
              {fleet.targets.length} frozen target(s) · wave {Math.min(fleet.currentWave + 1, fleet.waves.length)}/{fleet.waves.length} · {fleet.activeCallCount} active call(s)
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={fleetVariant(fleet.state)}>{fleet.state}</Badge>
            <Badge variant="outline">
              {fleet.writeIntent ? `canary ${fleet.policy.canarySize}` : 'read-only batches'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {attention && (
          <Alert variant="destructive" size="sm">
            <ShieldAlertIcon />
            <AlertTitle>Fleet has explicit host-level failures</AlertTitle>
            <AlertDescription>
              {fleet.failureCount} failed target(s). Unstarted targets remain visible as blocked; no aggregate status overrides the matrix.
            </AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Group / environment</TableHead>
              <TableHead>Wave</TableHead>
              <TableHead>Native state</TableHead>
              <TableHead>Verification / failure</TableHead>
              <TableHead>Rollback</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fleet.targets.map((target) => (
              <TableRow key={target.targetId}>
                <TableCell>
                  <div className="flex max-w-48 flex-col gap-0.5">
                    <span className="truncate" title={target.displayName}>{target.displayName}</span>
                    <span className="truncate text-muted-foreground" title={target.targetId}>
                      {target.targetId}
                    </span>
                  </div>
                </TableCell>
                <TableCell>{target.group} / {target.environment}</TableCell>
                <TableCell>{target.waveIndex + 1}</TableCell>
                <TableCell>
                  <Badge variant={targetVariant(target.state)}>{target.state}</Badge>
                </TableCell>
                <TableCell className="max-w-72 whitespace-normal">
                  {target.lastError
                    ?? target.verificationSummary
                    ?? (target.state === 'awaitingVerification'
                      ? 'Independent Verifier evidence required'
                      : 'No native evidence yet')}
                </TableCell>
                <TableCell>
                  {target.rollbackCheckpointId
                    ? <Badge variant="outline">restored</Badge>
                    : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-2">
        <span className="text-muted-foreground">
          {fleet.subAgents.filter((agent) => agent.active).length} active isolated role(s) · {fleet.callsUsed}/{fleet.policy.maxCallsTotal} calls
        </span>
        <span className="max-w-64 truncate text-muted-foreground" title={fleet.targetSnapshotSha256}>
          frozen snapshot {fleet.targetSnapshotSha256}
        </span>
      </CardFooter>
    </Card>
  );
}

export function AgentM5FleetCenter(): React.ReactNode {
  const [fleets, setFleets] = useState<readonly AgentFleetSnapshotV3[]>([]);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setFleets(await invokeAgentV3ListFleets());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void invokeAgentV3RolloutPolicy()
      .then(async (rollout) => {
        if (rollout.stage !== 'runtime') return;
        const next = await invokeAgentV3ListFleets();
        if (!active) return;
        setFleets(next);
        setVisible(true);
      })
      .catch(() => {
        // Agent v2 remains authoritative when the independent v3 runtime is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!visible || (fleets.length === 0 && !error)) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section aria-label="Agent v3 M5 Fleet result matrix" className="flex shrink-0 flex-col gap-2 px-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <NetworkIcon aria-hidden="true" />
              <span>Fleet rollout matrix</span>
            </div>
            <div className="text-muted-foreground">
              {fleets.length} Rust-owned Fleet(s); host failures and reconciliation remain explicit
            </div>
          </div>
          <div className="flex gap-1.5">
            <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
              Matrix
              <ChevronRightIcon
                data-icon="inline-end"
                className={cn('transition-transform', open && 'rotate-90')}
              />
            </CollapsibleTrigger>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void refresh()}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </div>
        {error && (
          <Alert variant="destructive" size="sm">
            <AlertTitle>M5 Fleet refresh failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <CollapsibleContent className="flex flex-col gap-2">
          {fleets.map((fleet) => <FleetCard key={fleet.fleetId} fleet={fleet} />)}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

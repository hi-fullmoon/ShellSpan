import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArchiveIcon, ChevronRightIcon, RefreshCwIcon } from 'lucide-react';

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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  invokeAgentV3CompactContext,
  invokeAgentV3GetTask,
  invokeAgentV3ListTasks,
  invokeAgentV3RefreshContext,
  invokeAgentV3RefreshExtensions,
  invokeAgentV3RolloutPolicy,
  isTauriRuntime,
} from '@/lib/tauri';
import type {
  AgentContextFragmentV3,
  AgentContextLayerV3,
  AgentTaskSnapshotV3,
} from '@/types/agent-v3';
import { cn } from '@/lib/utils';

const CONTEXT_LAYERS: readonly AgentContextLayerV3[] = ['workspace', 'host', 'session', 'task'];

function fragmentsForLayer(
  task: AgentTaskSnapshotV3,
  layer: AgentContextLayerV3,
): readonly AgentContextFragmentV3[] {
  return task.context.fragments.filter((fragment) => fragment.layer === layer);
}

function sourceVariant(
  fragment: AgentContextFragmentV3,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (fragment.omissionReason) return 'destructive';
  if (fragment.instructionEligible) return 'default';
  if (fragment.untrusted) return 'outline';
  return 'secondary';
}

function ContextLayerCard({
  layer,
  fragments,
}: {
  readonly layer: AgentContextLayerV3;
  readonly fragments: readonly AgentContextFragmentV3[];
}): React.ReactNode {
  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle>{layer}</CardTitle>
        <CardDescription>{fragments.length} bounded source{fragments.length === 1 ? '' : 's'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {fragments.length === 0 && <span className="text-muted-foreground">No source loaded.</span>}
        {fragments.map((fragment) => (
          <div key={fragment.fragmentId} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate" title={fragment.source}>{fragment.source}</span>
              <Badge variant={sourceVariant(fragment)}>{fragment.sourceKind}</Badge>
              <Badge variant="outline">P{fragment.priority}</Badge>
              <Badge variant="outline">{fragment.sensitivity}</Badge>
            </div>
            <span className="text-muted-foreground">
              {fragment.byteLength} bytes · ~{fragment.estimatedTokens} tokens · {fragment.trust}
              {fragment.instructionEligible ? ' · instruction eligible' : ' · data only'}
            </span>
            {fragment.overrides.length > 0 && (
              <span className="text-muted-foreground">
                Overrides: {fragment.overrides.join(', ')}
              </span>
            )}
            {fragment.omissionReason ? (
              <span>Omitted by Rust: {fragment.omissionReason}</span>
            ) : (
              fragment.preview && <span className="line-clamp-2">{fragment.preview}</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function AgentM3ContextSurface(): React.ReactNode {
  const [tasks, setTasks] = useState<readonly AgentTaskSnapshotV3[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'compact'>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const latestTask = useMemo(() => tasks[tasks.length - 1], [tasks]);

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
        // v2 remains authoritative when the explicit v3 runtime is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!latestTask) return;
    setBusy('refresh');
    setError(undefined);
    try {
      await invokeAgentV3RefreshContext(latestTask.request.taskId);
      await invokeAgentV3RefreshExtensions(latestTask.request.taskId);
      const task = await invokeAgentV3GetTask(latestTask.request.taskId);
      setTasks((current) => [...current.slice(0, -1), task]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [latestTask]);

  const compact = useCallback(async () => {
    if (!latestTask) return;
    setBusy('compact');
    setError(undefined);
    try {
      await invokeAgentV3CompactContext(latestTask.request.taskId, 'manual');
      const task = await invokeAgentV3GetTask(latestTask.request.taskId);
      setTasks((current) => [...current.slice(0, -1), task]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [latestTask]);

  if (!visible || !latestTask) return null;

  const { context, extensions, mcpServers } = latestTask;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section aria-label="Agent v3 M3 context and fee viewer" className="flex shrink-0 flex-col gap-2 px-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div>Context &amp; fee viewer</div>
            <div className="text-muted-foreground">
              {context.usage.modelVisibleBytes} visible bytes · ~{context.usage.estimatedInputTokens} input tokens · monetary estimate unavailable
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
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
            <Button variant="outline" size="xs" disabled={Boolean(busy)} onClick={() => void compact()}>
              <ArchiveIcon data-icon="inline-start" />
              Compact
            </Button>
          </div>
        </div>
        {error && (
          <Alert variant="destructive" size="sm">
            <AlertTitle>M3 context action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <CollapsibleContent className="flex flex-col gap-2">
          <div className="grid gap-2 @xl:grid-cols-2">
            {CONTEXT_LAYERS.map((layer) => (
              <ContextLayerCard
                key={layer}
                layer={layer}
                fragments={fragmentsForLayer(latestTask, layer)}
              />
            ))}
          </div>
          <Card size="sm" variant="outline">
            <CardHeader>
              <CardTitle>Artifacts &amp; extensions</CardTitle>
              <CardDescription>{context.usage.costReason}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{context.artifacts.length} artifacts</Badge>
              <Badge variant="secondary">{extensions.skills.length} skills</Badge>
              <Badge variant="secondary">{extensions.hooks.length} hooks</Badge>
              <Badge variant="secondary">{extensions.runbooks.length} runbooks</Badge>
              {mcpServers.map((server) => (
                <Badge key={server.id} variant={server.health === 'healthy' ? 'default' : 'outline'}>
                  MCP {server.id}: {server.health}
                </Badge>
              ))}
              {context.compactionReason && (
                <Badge variant="outline">compacted: {context.compactionReason}</Badge>
              )}
            </CardContent>
          </Card>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

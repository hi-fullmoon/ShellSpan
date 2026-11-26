import { useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import { isTopLevelAiSession } from '@/lib/ai/session-list';
import type { AiSessionSummary, AiSessionView } from '@/lib/ai/session-adapter';

function isActiveStatus(status: AiSessionStatus): status is 'running' | 'waiting' {
  return status === 'running' || status === 'waiting';
}

const activeTasksRelativeTimeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

function getActiveTasksRelativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = activeTasksRelativeTimeFormatterCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    activeTasksRelativeTimeFormatterCache.set(locale, formatter);
  }
  return formatter;
}

function relativeTimeLabel(timestamp: string, locale: string): string {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return timestamp;
  const deltaSeconds = Math.round((then - Date.now()) / 1_000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteSeconds < 60
    ? [deltaSeconds, 'second']
    : absoluteSeconds < 3_600
      ? [Math.round(deltaSeconds / 60), 'minute']
      : absoluteSeconds < 86_400
        ? [Math.round(deltaSeconds / 3_600), 'hour']
        : [Math.round(deltaSeconds / 86_400), 'day'];
  return getActiveTasksRelativeTimeFormatter(locale).format(value, unit);
}

export function selectActiveWorkspaceTasks({
  sessions,
  currentView,
  activeTargetIds,
  sandboxAgentSessionId,
}: {
  readonly sessions: readonly AiSessionSummary[];
  readonly currentView?: AiSessionView | null;
  readonly activeTargetIds?: readonly string[];
  readonly sandboxAgentSessionId?: string | null;
}): readonly AiSessionSummary[] {
  const merged = new Map<string, AiSessionSummary>();
  for (const summary of sessions) {
    merged.set(summary.id, summary);
  }
  if (currentView) {
    const existing = merged.get(currentView.summary.id);
    merged.set(currentView.summary.id, {
      ...existing,
      ...currentView.summary,
      status: currentView.status,
      archived: currentView.summary.archived || currentView.snapshot.value.archived,
      targetId: currentView.summary.targetId ?? currentView.snapshot.value.header.target?.targetId ?? existing?.targetId,
    });
  }
  const all = [...merged.values()];
  return all
    .filter((summary) => {
      if (summary.archived || !isActiveStatus(summary.status)) return false;
      if (!isTopLevelAiSession(summary, all)) return false;
      if (activeTargetIds === undefined) return true;
      if (sandboxAgentSessionId && summary.id === sandboxAgentSessionId) return true;
      if (summary.targetId === undefined) return true;
      return activeTargetIds.includes(summary.targetId);
    })
    .sort((left, right) => {
      const leftPriority = left.status === 'waiting' ? 0 : 1;
      const rightPriority = right.status === 'waiting' ? 0 : 1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    });
}

export function shouldShowActiveTasksSwitcher(
  tasks: readonly AiSessionSummary[],
  currentSessionId: string | null | undefined,
): boolean {
  if (tasks.length > 1) return true;
  if (tasks.length === 1) return tasks[0].id !== currentSessionId;
  return false;
}

export interface AiActiveTasksSwitcherProps {
  readonly tasks: readonly AiSessionSummary[];
  readonly currentSessionId?: string | null;
  readonly onOpen: (summary: AiSessionSummary) => void;
  readonly onRefresh?: () => void;
}

export function AiActiveTasksSwitcher({
  tasks,
  currentSessionId = null,
  onOpen,
  onRefresh,
}: AiActiveTasksSwitcherProps): React.ReactNode {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);

  if (!shouldShowActiveTasksSwitcher(tasks, currentSessionId)) return null;

  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const waitingCount = tasks.filter((task) => task.status === 'waiting').length;
  const otherWaiting = tasks.some(
    (task) => task.id !== currentSessionId && task.status === 'waiting',
  );
  const attentionState: 'running' | 'waiting' = otherWaiting || runningCount === 0
    ? 'waiting'
    : 'running';

  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(t('ai.workspace.activeTasks.runningCount', { count: runningCount }));
  if (waitingCount > 0) summaryParts.push(t('ai.workspace.activeTasks.waitingCount', { count: waitingCount }));
  const summaryText = summaryParts.join(' · ');

  const triggerText = runningCount === 0
    ? t('ai.workspace.activeTasks.waitingCount', { count: tasks.length })
    : t('ai.workspace.activeTasks.runningCount', { count: tasks.length });
  const tooltipText = t('ai.workspace.activeTasks.triggerTooltip', { summary: summaryText });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onRefresh?.();
      }}
    >
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              render={(
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-slot="ai-active-tasks-trigger"
                  data-attention={attentionState}
                  className="ai-active-tasks-trigger h-7 max-w-36 shrink-0 gap-1 px-2"
                  aria-label={tooltipText}
                />
              )}
            />
          )}
        >
          <span
            className="ai-session-status-dot size-[7px] shrink-0"
            data-state={attentionState}
            aria-hidden="true"
          />
          <span className="hidden truncate @min-[400px]/ai-workspace:inline">{triggerText}</span>
          <span className="truncate @min-[400px]/ai-workspace:hidden">{tasks.length}</span>
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="ai-active-tasks-popover w-80 max-w-[calc(100vw-1rem)] max-h-[min(22rem,var(--available-height))] gap-1 overflow-hidden p-1.5"
      >
        <PopoverHeader className="flex shrink-0 flex-row items-center justify-between gap-2 px-2 py-1">
          <PopoverTitle className="text-xs font-medium text-muted-foreground">
            {t('ai.workspace.activeTasks.title')}
          </PopoverTitle>
          <Badge variant="secondary" size="sm" className="shrink-0">
            {summaryText}
          </Badge>
        </PopoverHeader>
        <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0}>
          <div className="flex min-w-0 flex-col gap-0.5" role="list" aria-label={t('ai.workspace.activeTasks.title')}>
            {tasks.map((task) => {
              const isCurrent = task.id === currentSessionId;
              const statusLabel = task.status === 'waiting'
                ? t('agent.session.status.waiting')
                : t('agent.outcome.running');
              const timeLabel = relativeTimeLabel(task.updatedAt, locale);
              return (
                <div key={task.id} role="listitem">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ai-active-tasks-row h-auto w-full min-w-0 items-start justify-start gap-1 px-2 py-1.5 text-left whitespace-normal"
                    aria-label={t('ai.workspace.activeTasks.open', { title: task.title, status: statusLabel })}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (!isCurrent) onOpen(task);
                    }}
                  >
                    <span
                      className="ai-active-tasks-status-icon mt-0.5 grid size-4 shrink-0 place-items-center"
                      aria-hidden="true"
                    >
                      {task.status === 'waiting'
                        ? <PauseCircleIcon data-status="waiting" />
                        : <LoaderCircleIcon data-status="running" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="line-clamp-2 w-full min-w-0 text-[13px] font-medium leading-4 text-foreground">
                        {task.title}
                      </span>
                      <span className="max-w-full truncate text-xs font-normal leading-4 text-muted-foreground">
                        {statusLabel} · {timeLabel}
                      </span>
                    </span>
                    {isCurrent ? (
                      <Badge variant="secondary" size="sm" className="ai-active-tasks-current-badge shrink-0">
                        {t('ai.workspace.subagents.current')}
                      </Badge>
                    ) : (
                      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
                        <ChevronRightIcon data-icon="inline-end" />
                      </span>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

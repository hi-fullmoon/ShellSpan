import { useState } from 'react';
import { BotIcon, ChevronDownIcon, HouseIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AiSubagentEntry } from '@/lib/ai/subagent-lineage';
import { AiSubagentTreeList } from './ai-subagent-tree';

export type AiSubagentCatalogEntry = AiSubagentEntry;

export function AiSubagentCatalog({
  root,
  current,
  currentBudgetExhausted = false,
  entries,
  onOpen,
  onRefresh,
}: {
  readonly root: AiSessionSummary;
  readonly current: AiSessionSummary;
  readonly currentBudgetExhausted?: boolean;
  readonly entries: readonly AiSubagentCatalogEntry[];
  readonly onOpen: (summary: AiSessionSummary) => void;
  readonly onRefresh?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const inSubagent = current.subagent !== undefined;
  if (entries.length === 0 && !inSubagent) return null;

  const presentedEntries: readonly AiSubagentCatalogEntry[] = root.id === current.id && root.subagent
    ? [{
        summary: root,
        parentSessionId: root.parentSessionId,
        role: root.subagent.role,
        continuable: root.subagent.continuable,
        status: root.status,
        depth: 1,
      }, ...entries]
    : entries;

  const runningCount = presentedEntries.filter((entry) => entry.status === 'running').length;
  const waitingCount = presentedEntries.filter((entry) => entry.status === 'waiting').length;
  const activeCount = runningCount + waitingCount;
  const otherWaiting = presentedEntries.some(
    (entry) => entry.summary.id !== current.id && entry.status === 'waiting',
  );
  const otherRunning = presentedEntries.some(
    (entry) => entry.summary.id !== current.id && entry.status === 'running',
  );
  const attentionState = inSubagent
    ? (otherWaiting ? 'waiting' : otherRunning ? 'running' : null)
    : (waitingCount > 0 ? 'waiting' : runningCount > 0 ? 'running' : null);

  const countKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.count.one'
    : 'ai.workspace.subagents.count.other';
  const countRunningKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.countRunning.one'
    : 'ai.workspace.subagents.countRunning.other';
  const shortCountKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.shortCount.one'
    : 'ai.workspace.subagents.shortCount.other';
  const triggerLabel = activeCount > 0
    ? t(countRunningKey, { count: presentedEntries.length, running: activeCount })
    : t(countKey, { count: presentedEntries.length });
  const accessibleTriggerLabel = inSubagent
    ? t('ai.workspace.subagents.lineageAria', { title: current.title })
    : triggerLabel;

  const currentIndex = presentedEntries.findIndex((entry) => entry.summary.id === current.id);
  const compactPositionText = inSubagent && currentIndex >= 0 && presentedEntries.length > 1
    ? `${currentIndex + 1}/${presentedEntries.length}`
    : t(shortCountKey, { count: presentedEntries.length });
  const headerBadgeText = waitingCount > 0
    ? t('ai.workspace.subagents.status.waiting', { count: waitingCount })
    : runningCount > 0
      ? t('ai.workspace.subagents.status.running', { count: runningCount })
      : t(shortCountKey, { count: presentedEntries.length });

  const rows = (
    <AiSubagentTreeList
      entries={presentedEntries}
      currentSessionId={current.id}
      currentBudgetExhausted={currentBudgetExhausted}
      onSelect={(summary) => {
        setOpen(false);
        if (summary.id !== current.id) onOpen(summary);
      }}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onRefresh?.();
      }}
    >
      <PopoverTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ai-subagent-switcher-trigger h-7 max-w-36 shrink-0 gap-1 px-1.5"
            aria-label={accessibleTriggerLabel}
          />
        )}
      >
        <BotIcon data-icon="inline-start" />
        <span className="truncate">{compactPositionText}</span>
        {attentionState && (
          <span className="ai-subagent-switcher-dot size-1.5 shrink-0" data-state={attentionState} aria-hidden="true" />
        )}
        <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="ai-subagent-popover w-80 max-w-[calc(100vw-1rem)] max-h-[min(22rem,var(--available-height))] gap-1 overflow-hidden p-1.5">
        <PopoverHeader className="flex shrink-0 flex-row items-center justify-between gap-2 px-2 py-1">
          <PopoverTitle className="text-xs font-medium text-muted-foreground">
            {t('ai.workspace.subagents.switcherTitle')}
          </PopoverTitle>
          <Badge variant="secondary" size="sm" className="shrink-0">{headerBadgeText}</Badge>
        </PopoverHeader>
        {root.id !== current.id && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ai-subagent-tree-row h-auto w-full min-w-0 shrink-0 items-start justify-start gap-1 px-2 py-1.5 text-left"
              aria-label={t('ai.workspace.subagents.openRoot', { title: root.title })}
              onClick={() => {
                setOpen(false);
                onOpen(root);
              }}
            >
              <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
                <HouseIcon data-icon="inline-start" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium leading-4">{root.title}</span>
              <Badge variant="secondary" size="sm" className="shrink-0">{t('ai.workspace.subagents.root')}</Badge>
            </Button>
            <Separator className="my-0.5 shrink-0" />
          </>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0}>
          {rows}
        </div>
      </PopoverContent>
    </Popover>
  );
}

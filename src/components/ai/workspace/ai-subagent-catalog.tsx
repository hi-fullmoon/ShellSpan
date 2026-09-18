import { useState } from 'react';
import { BotIcon, ChevronDownIcon, ChevronRightIcon, HouseIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AgentActivityAgent, AgentSessionRuntimeStatus } from '@/types/agent-session';

export interface AiSubagentCatalogEntry {
  readonly summary: AiSessionSummary;
  readonly role: AgentActivityAgent['role'];
  readonly continuable: boolean;
  readonly status: AgentSessionRuntimeStatus;
  readonly depth: number;
  readonly detail?: string;
}

function roleLabel(role: AgentActivityAgent['role'], t: ReturnType<typeof useI18n>['t']): string {
  switch (role) {
    case 'general': return t('ai.workspace.subagents.role.general');
    case 'explorer': return t('ai.workspace.subagents.role.explorer');
    case 'diagnostician': return t('ai.workspace.subagents.role.diagnostician');
    case 'operator': return t('ai.workspace.subagents.role.operator');
    case 'verifier': return t('ai.workspace.subagents.role.verifier');
    case 'reviewer': return t('ai.workspace.subagents.role.reviewer');
    default: return t('ai.workspace.subagents.role.subagent');
  }
}

function statusLabel(status: AgentSessionRuntimeStatus, t: ReturnType<typeof useI18n>['t']): string {
  if (status === 'idle') return t('agent.session.status.idle');
  if (status === 'waiting') return t('agent.session.status.waiting');
  return t(`agent.outcome.${status}`);
}

function CatalogRows({
  entries,
  currentSessionId,
  close,
  onOpen,
}: {
  readonly entries: readonly AiSubagentCatalogEntry[];
  readonly currentSessionId: string;
  readonly close: () => void;
  readonly onOpen: (summary: AiSessionSummary) => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-1" role="list">
      {entries.map((entry) => {
        const current = entry.summary.id === currentSessionId;
        const role = roleLabel(entry.role, t);
        const mode = t(entry.continuable
          ? 'ai.workspace.subagents.mode.continuable'
          : 'ai.workspace.subagents.mode.oneShot');
        const status = statusLabel(entry.status, t);
        return (
          <div key={entry.summary.id} role="listitem">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full min-w-0 justify-start px-2 py-2 text-left whitespace-normal"
              aria-label={t('ai.workspace.subagents.open', {
                title: entry.summary.title,
                role,
                mode,
                status,
              })}
              onClick={() => {
                close();
                if (!current) onOpen(entry.summary);
              }}
              aria-current={current ? 'page' : undefined}
            >
              {Array.from({ length: Math.min(Math.max(entry.depth - 1, 0), 8) }, (_, index) => (
                <span key={index} className="w-3 shrink-0" aria-hidden="true" />
              ))}
              <span className="relative grid size-7 shrink-0 place-items-center" aria-hidden="true">
                <BotIcon data-icon="inline-start" />
                <span
                  className="ai-session-status-dot absolute right-0 bottom-0 size-2"
                  data-state={entry.status}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="flex min-w-0 max-w-full items-center gap-1.5">
                  <span className="truncate font-medium">{entry.summary.title}</span>
                  <Badge variant="outline" size="sm">{role}</Badge>
                  {current && <Badge variant="secondary" size="sm">{t('ai.workspace.subagents.current')}</Badge>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {mode} · {status}
                </span>
                {entry.detail && entry.detail !== entry.summary.title && (
                  <span className="max-w-full truncate text-xs text-muted-foreground">
                    {entry.detail}
                  </span>
                )}
              </span>
              {!current && <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

export function AiSubagentCatalog({
  root,
  current,
  entries,
  onOpen,
  onRefresh,
}: {
  readonly root: AiSessionSummary;
  readonly current: AiSessionSummary;
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
        role: root.subagent.role,
        continuable: root.subagent.continuable,
        status: root.status,
        depth: 0,
      }, ...entries]
    : entries;

  const runningCount = presentedEntries.filter((entry) => (
    entry.status === 'running' || entry.status === 'waiting'
  )).length;
  const countKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.count.one'
    : 'ai.workspace.subagents.count.other';
  const countRunningKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.countRunning.one'
    : 'ai.workspace.subagents.countRunning.other';
  const shortCountKey = presentedEntries.length === 1
    ? 'ai.workspace.subagents.shortCount.one'
    : 'ai.workspace.subagents.shortCount.other';
  const triggerLabel = runningCount > 0
    ? t(countRunningKey, { count: presentedEntries.length, running: runningCount })
    : t(countKey, { count: presentedEntries.length });
  const accessibleTriggerLabel = inSubagent
    ? t('ai.workspace.subagents.lineageAria', { title: current.title })
    : triggerLabel;
  const rows = (
    <CatalogRows
      entries={presentedEntries}
      currentSessionId={current.id}
      close={() => setOpen(false)}
      onOpen={onOpen}
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
            className="max-w-32 shrink-0 px-1.5"
            aria-label={accessibleTriggerLabel}
          />
        )}
      >
        <BotIcon data-icon="inline-start" />
        <span className="truncate">
          {inSubagent
            ? t('ai.workspace.subagents.lineage')
            : t(shortCountKey, { count: presentedEntries.length })}
        </span>
        {runningCount > 0 && (
          <span className="ai-session-status-dot size-1.5 shrink-0" data-state="running" aria-hidden="true" />
        )}
        <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80">
        <PopoverHeader>
          <PopoverTitle>{t('ai.workspace.subagents.title')}</PopoverTitle>
        </PopoverHeader>
        {root.id !== current.id && (
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start px-2 py-2 text-left"
            aria-label={t('ai.workspace.subagents.openRoot', { title: root.title })}
            onClick={() => {
              setOpen(false);
              onOpen(root);
            }}
          >
            <HouseIcon data-icon="inline-start" />
            <span className="min-w-0 flex-1 truncate">{root.title}</span>
            <Badge variant="secondary" size="sm">{t('ai.workspace.subagents.root')}</Badge>
          </Button>
        )}
        {presentedEntries.length > 4
          ? <ScrollArea className="h-64" size="thin">{rows}</ScrollArea>
          : rows}
      </PopoverContent>
    </Popover>
  );
}

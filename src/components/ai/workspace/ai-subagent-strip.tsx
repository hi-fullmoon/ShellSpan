import { useId, useState } from 'react';
import { BotIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AiSubagentEntry } from '@/lib/ai/subagent-lineage';
import { AiSubagentTreeList } from './ai-subagent-tree';

const SUBAGENT_STATUS_ORDER = ['waiting', 'running', 'failed', 'completed', 'cancelled', 'idle'] as const;

export interface AiSubagentStripProps {
  readonly entries: readonly AiSubagentEntry[];
  readonly currentSessionId: string;
  readonly currentBudgetExhausted?: boolean;
  readonly onOpen: (summary: AiSessionSummary) => void;
  readonly onRefresh?: () => void;
}

/** Collapsible docked summary bar for active and recorded subagent sessions. */
export function AiSubagentStrip({
  entries,
  currentSessionId,
  currentBudgetExhausted = false,
  onOpen,
  onRefresh,
}: AiSubagentStripProps): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  if (entries.length === 0) return null;

  const progress = SUBAGENT_STATUS_ORDER.flatMap((status) => {
    const count = entries.filter((entry) => entry.status === status).length;
    return count > 0 ? [t(`ai.workspace.subagents.status.${status}`, { count })] : [];
  }).join(' · ');

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onRefresh?.();
      }}
      className="ai-subagent-strip w-full min-w-0 shrink-0 overflow-hidden box-border"
      data-slot="ai-subagent-strip"
    >
      <CollapsibleTrigger
        className="ai-subagent-strip-trigger flex min-h-8 w-full min-w-0 cursor-default items-center gap-1 px-3 py-1 [&>:last-child]:ml-auto"
        aria-label={t('ai.workspace.subagents.toggleStrip', { count: entries.length })}
        aria-describedby={summaryId}
      >
        <BotIcon aria-hidden="true" data-icon="inline-start" />
        <span className="ai-subagent-strip-title shrink-0">{t('ai.workspace.subagents.title')}</span>
        <span id={summaryId} className="ai-subagent-strip-progress min-w-0 flex-auto truncate">
          {progress}
        </span>
        {open
          ? <ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
          : <ChevronUpIcon aria-hidden="true" data-icon="inline-end" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ai-subagent-strip-list max-h-56 overflow-y-auto px-1 pt-0.5 pb-1.5" tabIndex={0}>
          <AiSubagentTreeList
            entries={entries}
            currentSessionId={currentSessionId}
            currentBudgetExhausted={currentBudgetExhausted}
            onSelect={(summary) => {
              setOpen(false);
              if (summary.id !== currentSessionId) onOpen(summary);
            }}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

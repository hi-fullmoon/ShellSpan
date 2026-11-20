import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  ShieldAlertIcon,
  SquareIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AiSubagentEntry } from '@/lib/ai/subagent-lineage';
import type { AgentActivityAgent, AgentSessionRuntimeStatus } from '@/types/agent-session';

type Translate = ReturnType<typeof useI18n>['t'];

export function subagentRoleLabel(role: AgentActivityAgent['role'], t: Translate): string {
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

export function subagentStatusLabel(
  status: AgentSessionRuntimeStatus | 'approval' | 'uncertain',
  t: Translate,
): string {
  if (status === 'approval') return t('ai.workspace.tool.approval');
  if (status === 'uncertain') return t('ai.workspace.tool.uncertain');
  if (status === 'idle') return t('agent.session.status.idle');
  if (status === 'waiting') return t('agent.session.status.waiting');
  return t(`agent.outcome.${status}`);
}

export function subagentModeLabel(
  continuable: boolean,
  budgetExhausted: boolean,
  t: Translate,
): string {
  return t(budgetExhausted
    ? 'ai.workspace.subagents.mode.budgetExhausted'
    : continuable
      ? 'ai.workspace.subagents.mode.continuable'
      : 'ai.workspace.subagents.mode.oneShot');
}

export function formatSubagentDuration(durationMs: number | null | undefined, t: Translate): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1_000) return t('ai.workspace.durationMs', { duration: Math.round(durationMs) });
  const seconds = durationMs < 10_000
    ? Math.round(durationMs / 100) / 10
    : Math.round(durationMs / 1_000);
  return seconds < 60
    ? t('ai.workspace.duration.seconds', { seconds })
    : t('ai.workspace.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

export function SubagentStatusIcon({
  status,
}: {
  readonly status: AgentSessionRuntimeStatus | 'approval' | 'uncertain';
}): React.ReactNode {
  switch (status) {
    case 'running':
      return <LoaderCircleIcon data-status="running" />;
    case 'waiting':
      return <PauseCircleIcon data-status="waiting" />;
    case 'approval':
      return <ShieldAlertIcon data-status="approval" />;
    case 'uncertain':
      return <CircleHelpIcon data-status="uncertain" />;
    case 'completed':
      return <CheckCircle2Icon data-status="completed" />;
    case 'failed':
      return <OctagonAlertIcon data-status="failed" />;
    case 'cancelled':
      return <SquareIcon data-status="cancelled" />;
    case 'idle':
      return <CircleDashedIcon data-status="idle" />;
  }
}

export function AiSubagentTreeList({
  entries,
  currentSessionId,
  currentBudgetExhausted = false,
  onSelect,
}: {
  readonly entries: readonly AiSubagentEntry[];
  readonly currentSessionId: string;
  readonly currentBudgetExhausted?: boolean;
  readonly onSelect: (summary: AiSessionSummary) => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" role="list">
      {entries.map((entry) => {
        const current = entry.summary.id === currentSessionId;
        const role = subagentRoleLabel(entry.role, t);
        const mode = subagentModeLabel(entry.continuable, current && currentBudgetExhausted, t);
        const status = subagentStatusLabel(entry.status, t);
        const indentLevels = Math.min(Math.max(entry.depth - 1, 0), 6);
        return (
          <div key={entry.summary.id} role="listitem">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ai-subagent-tree-row h-auto w-full min-w-0 items-start justify-start gap-1 px-2 py-1.5 text-left whitespace-normal"
              aria-label={t('ai.workspace.subagents.open', {
                title: entry.summary.title,
                role,
                mode,
                status,
              })}
              onClick={() => {
                onSelect(entry.summary);
              }}
              aria-current={current ? 'page' : undefined}
            >
              {Array.from({ length: indentLevels }, (_, index) => (
                <span
                  key={index}
                  className="ai-subagent-tree-rail ml-[7px] w-[9px] shrink-0 self-stretch"
                  aria-hidden="true"
                />
              ))}
              <span
                className="ai-subagent-status-icon grid size-4 shrink-0 place-items-center"
                aria-hidden="true"
              >
                <SubagentStatusIcon status={entry.status} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="flex w-full min-w-0 items-center gap-1">
                  <span className="ai-subagent-tree-row-title min-w-0 truncate font-medium leading-4">{entry.summary.title}</span>
                  <Badge variant="outline" size="sm" className="shrink-0">{role}</Badge>
                </span>
                <span className="max-w-full truncate text-xs font-normal leading-4 text-muted-foreground">
                  {mode} · {status}
                </span>
                {entry.detail && entry.detail !== entry.summary.title && (
                  <span className="max-w-full truncate text-xs font-normal leading-4 text-muted-foreground">
                    {entry.detail}
                  </span>
                )}
              </span>
              {current ? (
                <Badge variant="secondary" size="sm" className="ai-subagent-current-badge shrink-0">
                  {t('ai.workspace.subagents.current')}
                </Badge>
              ) : (
                <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
                  <ChevronRightIcon data-icon="inline-end" />
                </span>
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

import { use, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PanelRightOpenIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { extractSubagentToolSummary } from '@/lib/ai/subagent-lineage';
import type { AgentSessionPlanStep, AgentSessionRuntimeStatus } from '@/types/agent-session';
import { AiSubagentContext } from './ai-subagent-context';
import {
  formatSubagentDuration,
  SubagentStatusIcon,
  subagentModeLabel,
  subagentRoleLabel,
  subagentStatusLabel,
} from './ai-subagent-tree';

const EMPTY_ID_MAP = new Map<string, string>();

function planStepIconStatus(status: AgentSessionPlanStep['status']): AgentSessionRuntimeStatus {
  switch (status) {
    case 'inProgress': return 'running';
    case 'blocked': return 'waiting';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'pending': return 'idle';
  }
}

export function AiSubagentToolCard({
  node,
  onInspect,
}: {
  readonly node: AiConversationNodeOf<'tool'>;
  readonly onInspect?: (node: AiConversationNodeOf<'tool'>) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const context = use(AiSubagentContext);
  const summary = extractSubagentToolSummary(
    node,
    context?.lineage ?? null,
    context?.toolChildSessionIds ?? EMPTY_ID_MAP,
  );
  const targetSummary = summary.childSessionId
    ? context?.lineage?.byId.get(summary.childSessionId)
    : undefined;
  const canOpen = Boolean(targetSummary && context?.onOpenSession);

  const roleText = subagentRoleLabel(summary.role, t);
  const badgeLabel = summary.action === 'spawn'
    ? roleText
    : `${t(`ai.workspace.subagents.card.action.${summary.action}`)} · ${roleText}`;
  const statusText = summary.partial && summary.status === 'completed'
    ? t('ai.workspace.subagents.card.partial')
    : subagentStatusLabel(summary.status, t);
  const durationText = formatSubagentDuration(summary.durationMs, t);

  const metaParts: string[] = [statusText];
  if (summary.action === 'spawn' && summary.continuable !== undefined) {
    metaParts.push(subagentModeLabel(summary.continuable, false, t));
  }
  if (summary.toolCallCount !== null && summary.toolCallCount > 0) {
    metaParts.push(t('ai.workspace.subagents.card.toolCalls', { count: summary.toolCallCount }));
  }
  if (durationText) {
    metaParts.push(durationText);
  }
  const metaLine = metaParts.join(' · ');

  const translatedError = summary.errorMessage
    ? aiErrorMessage(summary.errorMessage, t)
    : undefined;
  const translatedResult = summary.resultSummary && !translatedError
    ? aiErrorMessage(summary.resultSummary, t)
    : undefined;
  const showGoalInBody = Boolean(
    summary.goal && (summary.goal.trim() !== summary.title.trim() || summary.goal.includes('\n')),
  );
  const hasExpandableContent = Boolean(
    showGoalInBody
    || summary.inputContent
    || summary.plan.length > 0
    || translatedResult
    || translatedError
    || onInspect,
  );

  const isInteractive = canOpen || hasExpandableContent;

  const handlePrimaryClick = (): void => {
    if (canOpen && targetSummary && context?.onOpenSession) {
      context.onOpenSession(targetSummary);
      return;
    }
    if (hasExpandableContent) setOpen((previous) => !previous);
  };

  const mainContent = (
    <>
      <span
        className="ai-subagent-status-icon grid size-4 shrink-0 place-items-center"
        aria-hidden="true"
      >
        <SubagentStatusIcon status={summary.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1">
          <span className="ai-subagent-card-title min-w-0 truncate">
            {summary.title}
          </span>
          <Badge variant="outline" size="sm" className="shrink-0">
            {badgeLabel}
          </Badge>
        </span>
        <span className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
          {metaLine}
        </span>
      </span>
      {canOpen && (
        <span
          className="ai-subagent-card-enter grid size-4 shrink-0 self-center place-items-center text-muted-foreground"
          aria-hidden="true"
        >
          <ChevronRightIcon className="size-3.5" />
        </span>
      )}
    </>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-subagent-card relative my-0.5 min-w-0 max-w-full overflow-hidden"
        data-slot="ai-subagent-card"
        data-state={summary.status}
        data-action={summary.action}
        data-clickable={isInteractive || undefined}
        data-openable={canOpen || undefined}
      >
        <div className="flex min-w-0 items-center gap-1 p-1.5">
          {isInteractive ? (
            <button
              type="button"
              className="ai-subagent-card-main flex min-w-0 flex-1 cursor-default items-start gap-1 rounded-[8px] px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              data-ai-node-action=""
              aria-label={canOpen
                ? t('ai.workspace.subagents.card.openAria', {
                    title: summary.title,
                    role: roleText,
                    status: statusText,
                  })
                : `${badgeLabel}: ${summary.title} · ${statusText}`}
              aria-expanded={!canOpen && hasExpandableContent ? open : undefined}
              onClick={handlePrimaryClick}
            >
              {mainContent}
            </button>
          ) : (
            <div className="ai-subagent-card-main flex min-w-0 flex-1 items-start gap-1 rounded-[8px] px-1.5 py-1 text-left">
              {mainContent}
            </div>
          )}
          {hasExpandableContent && (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <CollapsibleTrigger
                    render={(
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="ai-subagent-card-toggle shrink-0 text-muted-foreground"
                        aria-label={t(open
                          ? 'ai.workspace.subagents.card.collapseSummary'
                          : 'ai.workspace.subagents.card.expandSummary')}
                      />
                    )}
                  />
                )}
              >
                <ChevronDownIcon className="ai-subagent-card-chevron" />
              </TooltipTrigger>
              <TooltipContent>
                {t(open
                  ? 'ai.workspace.subagents.card.collapseSummary'
                  : 'ai.workspace.subagents.card.expandSummary')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {hasExpandableContent && (
          <CollapsibleContent>
            <div className="ai-subagent-card-body flex min-w-0 flex-col gap-2 px-3 pt-2 pb-2.5 text-xs">
              {showGoalInBody && summary.goal && (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t('ai.workspace.subagents.card.goal')}
                  </span>
                  <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] leading-4 text-foreground/90">
                    {summary.goal}
                  </p>
                </div>
              )}
              {summary.inputContent && (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t('ai.workspace.subagents.card.input')}
                  </span>
                  <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] leading-4 text-foreground/90">
                    {summary.inputContent}
                  </p>
                </div>
              )}
              {summary.plan.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t('ai.workspace.subagents.card.plan')}
                  </span>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {summary.plan.map((step) => (
                      <li key={step.id} className="flex min-w-0 items-start gap-1">
                        <span
                          className="ai-subagent-status-icon grid size-4 shrink-0 place-items-center"
                          aria-hidden="true"
                        >
                          <SubagentStatusIcon status={planStepIconStatus(step.status)} />
                        </span>
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere] leading-4">
                          {step.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(translatedError || translatedResult) && (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t('ai.workspace.subagents.card.result')}
                  </span>
                  <p
                    className="ai-subagent-card-result m-0 whitespace-pre-wrap [overflow-wrap:anywhere] leading-4"
                    data-error={Boolean(translatedError) || undefined}
                  >
                    {translatedError ?? translatedResult}
                  </p>
                </div>
              )}
              {(canOpen || onInspect) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
                  {canOpen && targetSummary && context?.onOpenSession && (
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      onClick={() => context.onOpenSession!(targetSummary)}
                    >
                      {t('ai.workspace.subagents.card.open')}
                      <ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  )}
                  {onInspect && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => onInspect(node)}
                      aria-label={t('ai.workspace.details.openTool', { tool: summary.title })}
                    >
                      <PanelRightOpenIcon data-icon="inline-start" />
                      {t('ai.workspace.tool.inspect')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

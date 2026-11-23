import { use, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { extractSubagentToolSummary, type SubagentToolAction } from '@/lib/ai/subagent-lineage';
import { cn } from '@/lib/utils';
import type { AgentActivityAgent, AgentSessionPlanStep, AgentSessionRuntimeStatus } from '@/types/agent-session';
import {
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
  AI_TOOL_ROW_CLASS,
} from './ai-style-classes';
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

function subagentRowTitle(
  action: SubagentToolAction,
  role: AgentActivityAgent['role'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (action) {
    case 'spawn': {
      const roleLabel = subagentRoleLabel(role, t);
      return role === 'subagent' || roleLabel === t('ai.workspace.subagents.role.subagent')
        ? t('ai.workspace.subagents.role.subagent')
        : t('ai.workspace.subagents.card.title.spawnRole', { role: roleLabel });
    }
    case 'input':
      return t('ai.workspace.subagents.card.title.input');
    case 'retry':
      return t('ai.workspace.subagents.card.title.retry');
    case 'inspect':
      return t('ai.workspace.tool.title.inspectSubagent');
    case 'cancel':
      return t('ai.workspace.tool.title.cancelSubagent');
  }
}

export function AiSubagentToolCard({
  node,
}: {
  readonly node: AiConversationNodeOf<'tool'>;
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
  const rowTitle = subagentRowTitle(summary.action, summary.role, t);
  const statusText = summary.partial && summary.status === 'completed'
    ? t('ai.workspace.subagents.card.partial')
    : subagentStatusLabel(summary.status, t);
  const durationText = formatSubagentDuration(summary.durationMs, t);

  const showInlineStatus = summary.status !== 'completed' || summary.partial || !durationText;
  const inlineMetaParts = [
    ...(showInlineStatus ? [statusText] : []),
    ...(durationText ? [durationText] : []),
  ];
  const inlineMeta = inlineMetaParts.join(' · ');
  const inlineMetaState = summary.status === 'failed'
    || summary.status === 'waiting'
    || summary.status === 'approval'
    || summary.status === 'uncertain'
    ? summary.status
    : undefined;

  const translatedError = summary.errorMessage
    ? aiErrorMessage(summary.errorMessage, t)
    : undefined;
  const translatedResult = summary.resultSummary && !translatedError
    ? aiErrorMessage(summary.resultSummary, t)
    : undefined;
  const showGoalInBody = Boolean(
    summary.goal && (summary.goal.trim() !== summary.title.trim() || summary.goal.includes('\n')),
  );
  const hasBodyDetails = Boolean(
    (showGoalInBody && summary.goal)
    || summary.inputContent
    || summary.plan.length > 0
    || translatedResult
    || translatedError,
  );
  const hasSecondaryDetailMeta = (summary.action === 'spawn' && summary.continuable !== undefined)
    || (summary.toolCallCount !== null && summary.toolCallCount > 0);
  const detailMetaParts: string[] = [statusText];
  if (summary.action === 'spawn' && summary.continuable !== undefined) {
    detailMetaParts.push(subagentModeLabel(summary.continuable, false, t));
  }
  if (summary.toolCallCount !== null && summary.toolCallCount > 0) {
    detailMetaParts.push(t('ai.workspace.subagents.card.toolCalls', { count: summary.toolCallCount }));
  }
  if (durationText) {
    detailMetaParts.push(durationText);
  }
  const detailMetaLine = hasBodyDetails && hasSecondaryDetailMeta
    ? detailMetaParts.join(' · ')
    : null;

  const hasExpandableContent = hasBodyDetails;
  const canExpand = !canOpen && hasExpandableContent;
  const isInteractive = canOpen || canExpand;

  const openAria = t('ai.workspace.subagents.card.openAria', {
    title: summary.title,
    role: roleText,
    status: statusText,
  });

  const rowContent = (
    <>
      <span
        className={cn(AI_DISCLOSURE_LEADING_CLASS, 'ai-subagent-status-icon')}
        aria-hidden="true"
      >
        <SubagentStatusIcon status={summary.status} />
        {canOpen && <ChevronRightIcon className="ai-disclosure-chevron ai-subagent-row-enter" />}
        {canExpand && <ChevronDownIcon className="ai-disclosure-chevron" />}
      </span>
      <span className={AI_DISCLOSURE_TITLE_CLASS}>{rowTitle}</span>
      <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
      <span className={AI_DISCLOSURE_SUMMARY_CLASS}>{summary.title}</span>
      {inlineMeta && (
        <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
          <span className="ai-subagent-row-meta" data-state={inlineMetaState}>
            {inlineMeta}
          </span>
        </span>
      )}
    </>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-subagent-card flex min-w-0 max-w-full flex-col"
        data-slot="ai-subagent-card"
        data-state={summary.status}
        data-action={summary.action}
        data-clickable={isInteractive || undefined}
        data-openable={canOpen || undefined}
      >
        <div className="flex min-h-6 w-full min-w-0 items-center">
          {canOpen && targetSummary && context?.onOpenSession ? (
            <button
              type="button"
              className={cn(AI_TOOL_ROW_CLASS, 'ai-subagent-row-trigger flex-1')}
              data-ai-node-action=""
              aria-label={openAria}
              onClick={() => context.onOpenSession!(targetSummary)}
            >
              {rowContent}
            </button>
          ) : canExpand ? (
            <CollapsibleTrigger
              render={(
                <button
                  type="button"
                  className={cn(AI_TOOL_ROW_CLASS, 'ai-subagent-row-trigger flex-1')}
                  data-ai-node-action=""
                  aria-label={`${rowTitle}: ${summary.title}${inlineMeta ? ` · ${inlineMeta}` : ''}`}
                />
              )}
            >
              {rowContent}
            </CollapsibleTrigger>
          ) : (
            <div className={cn(AI_TOOL_ROW_CLASS, 'ai-subagent-row-trigger flex-1')}>
              {rowContent}
            </div>
          )}
        </div>
        {canExpand && (
          <CollapsibleContent>
            <div className="ai-subagent-card-body my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col overflow-hidden text-xs">
              {hasBodyDetails && (
                <ScrollArea
                  className="ai-subagent-card-scroll flex max-h-65 min-h-0 min-w-0 flex-col overflow-hidden"
                  viewportRender={(
                    <div
                      className="h-auto min-h-0 min-w-0 flex-1"
                      style={{ overflowX: 'hidden' }}
                    />
                  )}
                >
                  <ScrollAreaContent
                    className="flex min-w-0 flex-col gap-2 px-3 pt-2 pb-2.5"
                    style={{ minWidth: 0 }}
                  >
                    {detailMetaLine && (
                      <div className="text-[11px] leading-4 text-muted-foreground">
                        {detailMetaLine}
                      </div>
                    )}
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
                  </ScrollAreaContent>
                </ScrollArea>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

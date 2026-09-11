import { useId, useState } from 'react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
} from 'lucide-react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import type { AgentSessionPlanStep } from '@/types/agent-session';

export interface AiTaskStripProps {
  readonly steps: readonly AgentSessionPlanStep[];
}

const TASK_STATUS_ORDER = ['completed', 'inProgress', 'pending', 'blocked', 'failed'] as const;

function TaskStatusIcon({ status }: { readonly status: AgentSessionPlanStep['status'] }): React.ReactNode {
  switch (status) {
    case 'completed':
      return <CheckCircle2Icon data-status="completed" />;
    case 'inProgress':
      return <LoaderCircleIcon data-status="inProgress" />;
    case 'blocked':
    case 'failed':
      return <OctagonAlertIcon data-status={status} />;
    case 'pending':
      return <CircleDashedIcon data-status="pending" />;
  }
}

/** Collapsible projection of real Agent Runtime plan steps. */
export function AiTaskStrip({ steps }: AiTaskStripProps): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const progressId = useId();
  if (steps.length === 0) return null;
  const progress = TASK_STATUS_ORDER.flatMap((status) => {
    const count = steps.filter((step) => step.status === status).length;
    return count > 0 ? [t(`ai.workspace.tasks.${status}`, { count })] : [];
  }).join(' · ');

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="ai-task-strip mx-auto w-[calc(100%-32px)] min-w-0 max-w-[calc(var(--ai-composer-card-max-width)-32px)] shrink-0 overflow-hidden box-border @max-[400px]/ai-workspace:w-[calc(100%-20px)]"
      data-slot="ai-task-strip"
    >
      <CollapsibleTrigger
        className="ai-task-strip-trigger flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-1 [&>:last-child]:ml-auto"
        aria-label={t('ai.workspace.tasks.toggle', { count: steps.length })}
        aria-describedby={progressId}
      >
        <ListTodoIcon aria-hidden="true" data-icon="inline-start" />
        <span className="ai-task-strip-title shrink-0">{t('ai.workspace.tasks.title')}</span>
        <span id={progressId} className="ai-task-strip-progress min-w-0 flex-auto truncate">
          {progress}
        </span>
        {open
          ? <ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
          : <ChevronUpIcon aria-hidden="true" data-icon="inline-end" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="ai-task-strip-list m-0 flex max-h-[180px] list-none flex-col gap-2 overflow-y-auto px-3 pt-0.5 pb-1.5">
          {steps.map((step) => (
            <li className="flex min-h-5 min-w-0 shrink-0 items-center gap-2.5" key={step.id} data-status={step.status}>
              <span className="ai-task-strip-status grid size-4 shrink-0 place-items-center" aria-hidden="true">
                <TaskStatusIcon status={step.status} />
              </span>
              <span className="sr-only">{t(`ai.workspace.tasks.status.${step.status}`)}: </span>
              <span className="min-w-0 truncate">
                {step.title}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

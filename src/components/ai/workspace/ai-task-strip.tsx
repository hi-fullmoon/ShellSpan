import { useId, useState } from 'react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
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
  readonly active?: boolean;
}

type TaskDisplayStatus = AgentSessionPlanStep['status'] | 'paused';

const TASK_STATUS_ORDER = ['completed', 'inProgress', 'paused', 'pending', 'blocked', 'failed'] as const;

function TaskStatusIcon({ status }: { readonly status: TaskDisplayStatus }): React.ReactNode {
  switch (status) {
    case 'completed':
      return <CheckCircle2Icon data-status="completed" />;
    case 'inProgress':
      return <LoaderCircleIcon data-status="inProgress" />;
    case 'paused':
      return <PauseCircleIcon data-status="paused" />;
    case 'blocked':
    case 'failed':
      return <OctagonAlertIcon data-status={status} />;
    case 'pending':
      return <CircleDashedIcon data-status="pending" />;
  }
}

/** Collapsible projection of real Agent Runtime plan steps. */
export function AiTaskStrip({ steps, active = true }: AiTaskStripProps): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const progressId = useId();
  if (steps.length === 0) return null;
  const displayStatus = (step: AgentSessionPlanStep): TaskDisplayStatus => (
    step.status === 'inProgress' && !active ? 'paused' : step.status
  );
  const progress = TASK_STATUS_ORDER.flatMap((status) => {
    const count = steps.filter((step) => displayStatus(step) === status).length;
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
        className="ai-task-strip-trigger flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 px-3 py-1 [&>:last-child]:ml-auto"
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
            <li className="flex min-h-5 min-w-0 shrink-0 items-center gap-1" key={step.id} data-status={displayStatus(step)}>
              <span className="ai-task-strip-status grid size-4 shrink-0 place-items-center" aria-hidden="true">
                <TaskStatusIcon status={displayStatus(step)} />
              </span>
              <span className="sr-only">{t(`ai.workspace.tasks.status.${displayStatus(step)}`)}: </span>
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

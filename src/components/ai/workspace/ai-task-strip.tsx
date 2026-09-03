import { useState } from 'react';
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
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.status === 'completed').length;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="ai-task-strip"
      data-slot="ai-task-strip"
    >
      <CollapsibleTrigger
        className="ai-task-strip-trigger"
        aria-label={t('ai.workspace.tasks.toggle', { count: steps.length })}
      >
        <ListTodoIcon aria-hidden="true" />
        <span>{t('ai.workspace.tasks.title')}</span>
        <span className="ai-task-strip-progress">
          {t('ai.workspace.tasks.completed', { count: completed })}
        </span>
        {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="ai-task-strip-list">
          {steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              <span className="ai-task-strip-status" aria-hidden="true">
                <TaskStatusIcon status={step.status} />
              </span>
              <span className="truncate" title={step.detail ?? step.title}>{step.title}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

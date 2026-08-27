import { ArrowUpIcon, PlusIcon } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { isAgentRunTerminalStateV1 } from '@/lib/agent-state';
import type { AgentRunSnapshotV1 } from '@/types/agent';

function shouldSubmit(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.nativeEvent.isComposing
    && event.keyCode !== 229;
}

export function AgentComposer({
  snapshot,
  value,
  onChange,
  onSubmit,
  onNewDiagnosis,
  disabled = false,
  pending = false,
  modeControl,
  footerAction,
  contextHint,
}: {
  snapshot?: AgentRunSnapshotV1;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onNewDiagnosis: () => void;
  disabled?: boolean;
  pending?: boolean;
  modeControl?: React.ReactNode;
  footerAction?: React.ReactNode;
  contextHint?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const terminal = snapshot ? isAgentRunTerminalStateV1(snapshot.state) : false;
  const placeholder = !snapshot
    ? t('ai.dynamicAgent.composer.goal')
    : terminal
      ? t('ai.dynamicAgent.composer.terminal')
      : snapshot.state === 'awaitingUser' && snapshot.pendingQuestion
        ? t('ai.dynamicAgent.composer.question', { question: snapshot.pendingQuestion.question })
        : snapshot.state === 'paused'
          ? t('ai.dynamicAgent.composer.paused')
          : t('ai.dynamicAgent.composer.steering');
  const submitDisabled = disabled || terminal || pending || !value.trim();

  return (
    <div className="shrink-0 p-3 pt-2">
      <InputGroup className="min-h-24 rounded-2xl bg-card shadow-xs has-[[data-slot=input-group-control]:focus-visible]:ring-1">
        <InputGroupTextarea
          value={value}
          disabled={disabled || terminal}
          aria-label={placeholder}
          aria-describedby={contextHint
            ? 'dynamic-agent-composer-context dynamic-agent-composer-hint'
            : 'dynamic-agent-composer-hint'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (!shouldSubmit(event)) return;
            event.preventDefault();
            if (!submitDisabled) onSubmit();
          }}
          placeholder={placeholder}
          className="min-h-14 max-h-48 px-3.5 pt-3 pb-1 leading-5"
        />
        <InputGroupAddon align="block-end" className="px-2 pb-2 pt-1">
          <span id="dynamic-agent-composer-hint" className="sr-only">
            {t('ai.dynamicAgent.composer.hint')}
          </span>
          <div className="flex w-full min-w-0 items-center gap-2">
            {modeControl}
            {contextHint ? (
              <InputGroupText
                id="dynamic-agent-composer-context"
                className="min-w-0 flex-1 px-1 text-xs font-normal text-muted-foreground/60"
                title={contextHint}
                aria-live="polite"
              >
                <span className="min-w-0 truncate">{contextHint}</span>
              </InputGroupText>
            ) : (
              <span className="flex-1" />
            )}
            {terminal ? (
              <InputGroupButton
                variant="secondary"
                size="sm"
                onClick={onNewDiagnosis}
              >
                <PlusIcon data-icon="inline-start" />
                {t('ai.dynamicAgent.newDiagnosis')}
              </InputGroupButton>
            ) : (
              <InputGroupButton
                variant="default"
                size="icon-sm"
                className="shrink-0 rounded-full"
                onClick={onSubmit}
                disabled={submitDisabled}
                aria-label={snapshot ? t('ai.send') : t('ai.dynamicAgent.start')}
              >
                {pending
                  ? <Spinner />
                  : <ArrowUpIcon />}
              </InputGroupButton>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
      {footerAction}
    </div>
  );
}

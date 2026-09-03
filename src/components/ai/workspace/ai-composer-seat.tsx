import { useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  ListPlusIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiContextUsage, AiInboxItem, AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionPlanStep } from '@/types/agent-session';
import { AiApprovalPanel } from './ai-approval-panel';
import { AiContextMeter } from './ai-context-meter';
import { AiQueueDock } from './ai-queue-dock';
import { AiTaskStrip } from './ai-task-strip';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiComposerSeatProps {
  readonly phase: 'hero' | 'active';
  readonly status: AiSessionStatus;
  readonly defaultDraft?: string;
  readonly draft?: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  readonly modelControl?: React.ReactNode;
  readonly contextUsage?: AiContextUsage;
  readonly permissionControl?: React.ReactNode;
  readonly composerState?: AiComposerState;
  readonly inbox?: readonly AiInboxItem[];
  readonly taskSteps?: readonly AgentSessionPlanStep[];
  readonly queueMutation?: AiQueueMutationState | null;
  readonly announcement?: string | null;
  readonly pendingApproval?: AiPendingApproval | null;
  readonly approvalDecision?: 'approve' | 'reject' | null;
  readonly approvalError?: string | null;
  readonly unavailableReason?: string | null;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onReorderQueueLane?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onRetryQueueMutation?: () => void;
  readonly onRetryFailedDraft?: (failedDraftId: string) => void;
  readonly onDismissError?: () => void;
  readonly onOpenModel?: () => void;
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly onOpenApprovalDetails?: () => void;
}

/** Harness-aligned Composer surface backed by the existing ShellSpan state machine. */
export function AiComposerSeat({
  phase,
  status,
  defaultDraft = '',
  draft: controlledDraft,
  providerLabel,
  modelLabel,
  modelControl,
  contextUsage,
  permissionControl,
  composerState,
  inbox = [],
  taskSteps = [],
  queueMutation = null,
  announcement,
  pendingApproval,
  approvalDecision = null,
  approvalError = null,
  unavailableReason = null,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onBusyPreferenceChange,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onReorderQueueLane,
  onRetryQueueMutation,
  onRetryFailedDraft,
  onDismissError,
  onOpenModel,
  onApprove,
  onReject,
  onOpenApprovalDetails,
}: AiComposerSeatProps): React.ReactNode {
  const { t } = useI18n();
  const [localDraft, setLocalDraft] = useState(defaultDraft);
  const composingRef = useRef(false);
  const composingUntilRef = useRef(0);
  const draft = composerState?.draft ?? controlledDraft ?? localDraft;
  const running = status === 'running' || status === 'waiting';
  const waitingApproval = composerState?.phase === 'waitingApproval';
  const submitting = composerState?.phase === 'submitting';
  const terminal = composerState?.terminal ?? false;
  const unavailable = unavailableReason !== null;
  const empty = draft.trim().length === 0;
  const stopPrimary = running && empty;
  const submitDisabled = terminal
    || waitingApproval
    || submitting
    || (stopPrimary
      ? onStop === undefined
      : unavailable || empty || (onSubmitGesture === undefined && onSubmit === undefined));
  const busyPreference = composerState?.preferredBusyMode ?? 'queue';
  const primaryLabel = stopPrimary
    ? t('ai.workspace.stop')
    : running
      ? busyPreference === 'queue'
        ? t('ai.workspace.queue.action')
        : t('ai.workspace.steer.action')
      : t('ai.send');
  const queueItems = useMemo<readonly AiInboxItem[]>(() => {
    const items = [...inbox];
    for (const pending of composerState?.pendingSubmissions ?? []) {
      if (pending.mode === 'start') continue;
      if (items.some((item) => (
        item.id === pending.clientOperationId
        || item.clientSubmissionId === pending.clientOperationId
      ))) continue;
      items.push({
        id: pending.clientOperationId,
        clientSubmissionId: pending.clientOperationId,
        lane: pending.mode === 'nextStep' ? 'nextStep' : 'nextTurn',
        content: pending.content,
        state: 'pending',
        source: 'user',
      });
    }
    return items;
  }, [composerState?.pendingSubmissions, inbox]);

  const updateDraft = (value: string): void => {
    if (composerState === undefined && controlledDraft === undefined) setLocalDraft(value);
    onDraftChange?.(value);
  };
  const submit = (gesture: 'keyboard' | 'primary', accelerated = false): void => {
    if (submitDisabled) return;
    if (stopPrimary) {
      onStop?.();
      return;
    }
    if (onSubmitGesture) onSubmitGesture(gesture, accelerated);
    else void onSubmit?.(draft);
  };

  return (
    <div
      data-slot="ai-composer-seat"
      data-composer-seat=""
      data-phase={phase}
      className="ai-composer-seat"
    >
      <AiTaskStrip steps={taskSteps} />
      <div className="ai-composer-notices">
        {unavailableReason && (
          <Alert size="sm">
            <AlertTitle>{t('agent.availability.title')}</AlertTitle>
            <AlertDescription>{unavailableReason}</AlertDescription>
          </Alert>
        )}
        <AiQueueDock
          items={queueItems}
          mutation={queueMutation}
          onUpdate={onUpdateQueueItem}
          onRemove={onRemoveQueueItem}
          onReorder={onReorderQueueLane}
          onRetry={onRetryQueueMutation}
        />
        {waitingApproval && !pendingApproval && (
          <Alert size="sm">
            <AlertTitle>{t('ai.workspace.approvalWaiting')}</AlertTitle>
            <AlertDescription>{t('ai.workspace.approvalPhase5')}</AlertDescription>
          </Alert>
        )}
        {composerState?.lastError && (
          <Alert variant="destructive" size="sm">
            <AlertTitle>{t('ai.workspace.recovery.title')}</AlertTitle>
            <AlertDescription className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{composerState.lastError.message}</span>
              {onDismissError && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('ai.workspace.recovery.dismiss')}
                  onClick={onDismissError}
                >
                  <XIcon />
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {composerState?.failedDrafts.map((failed) => (
          <Alert key={failed.id} variant="destructive" size="sm">
            <AlertTitle>{t('ai.workspace.failedDraft')}</AlertTitle>
            <AlertDescription className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{failed.content}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={submitting || !failed.error.retryable}
                onClick={() => onRetryFailedDraft?.(failed.id)}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {t('common.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ))}
      </div>
      {waitingApproval && pendingApproval ? (
        <AiApprovalPanel
          approval={pendingApproval}
          decision={approvalDecision}
          error={approvalError}
          onApprove={() => onApprove?.()}
          onReject={() => onReject?.()}
          onOpenDetails={() => onOpenApprovalDetails?.()}
        />
      ) : (
        <InputGroup data-composer-card="">
          <InputGroupTextarea
            data-testid="ai-workspace-composer"
            value={draft}
            disabled={waitingApproval || unavailable}
            onChange={(event) => updateDraft(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              composingUntilRef.current = Date.now() + 10;
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (
                event.nativeEvent.isComposing
                || event.keyCode === 229
                || composingRef.current
                || Date.now() < composingUntilRef.current
              ) return;
              event.preventDefault();
              if (event.repeat) return;
              submit('keyboard', event.metaKey || event.ctrlKey);
            }}
            placeholder={t('ai.workspace.composerPlaceholder')}
          />
          <InputGroupAddon align="block-end" className="ai-composer-toolbar">
            <div className="ai-composer-tools">
              {permissionControl}
              {running && (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <DropdownMenuTrigger
                          render={(
                            <Button
                              variant="ghost"
                              size="xs"
                              className="ai-busy-preference-trigger"
                              aria-label={t('ai.workspace.busyPreference')}
                            />
                          )}
                        />
                      )}
                    >
                      {busyPreference === 'queue'
                        ? <ListPlusIcon data-icon="inline-start" />
                        : <CornerUpLeftIcon data-icon="inline-start" />}
                      <span className="ai-busy-preference-label">
                        {busyPreference === 'queue'
                          ? t('ai.workspace.queue.action')
                          : t('ai.workspace.steer.action')}
                      </span>
                      <ChevronDownIcon data-icon="inline-end" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {busyPreference === 'queue'
                        ? t('ai.workspace.queue.tooltip')
                        : t('ai.workspace.steer.tooltip')}
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent side="top" sideOffset={8} align="start">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('ai.workspace.busyPreference')}</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => onBusyPreferenceChange?.('queue')}>
                        <ListPlusIcon />
                        {t('ai.workspace.queue.action')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onBusyPreferenceChange?.('steer')}>
                        <CornerUpLeftIcon />
                        {t('ai.workspace.steer.action')}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <div className="ai-composer-trailing">
              {modelControl ?? (modelLabel && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ai-model-trigger"
                  disabled={!onOpenModel}
                  onClick={onOpenModel}
                  aria-label={t('ai.workspace.model.trigger', { selection: modelLabel })}
                  title={`${providerLabel ? `${providerLabel} · ` : ''}${modelLabel}`}
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDownIcon data-icon="inline-end" />
                </Button>
              ))}
              <AiContextMeter usage={contextUsage} />
              {running && !stopPrimary && onStop && (
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <InputGroupButton
                        variant="ghost"
                        size="icon-sm"
                        className="ai-composer-primary ai-composer-stop"
                        onClick={onStop}
                        aria-label={t('ai.workspace.stop')}
                      />
                    )}
                  >
                    <SquareIcon fill="currentColor" />
                  </TooltipTrigger>
                  <TooltipContent>{t('ai.workspace.stopTooltip')}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <InputGroupButton
                      variant="default"
                      size="icon-sm"
                      className="ai-composer-primary"
                      onClick={() => submit('primary')}
                      disabled={submitDisabled}
                      aria-label={primaryLabel}
                    />
                  )}
                >
                  {stopPrimary
                    ? <SquareIcon fill="currentColor" />
                    : <ArrowUpIcon />}
                </TooltipTrigger>
                <TooltipContent>
                  {waitingApproval
                    ? t('ai.workspace.approvalWaiting')
                    : unavailableReason
                      ? unavailableReason
                    : terminal
                      ? t('ai.workspace.sessionEnded')
                      : primaryLabel}
                </TooltipContent>
              </Tooltip>
            </div>
          </InputGroupAddon>
        </InputGroup>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement ? t(`ai.workspace.announce.${announcement}` as LocaleKey) : null}
      </span>
    </div>
  );
}

import { useState } from 'react';
import {
  ArrowUpIcon,
  BotIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  CpuIcon,
  ListPlusIcon,
  PaperclipIcon,
  RotateCcwIcon,
  ServerIcon,
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
import type { AiSessionKind, AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { AiQueueDock } from './ai-queue-dock';
import { AiApprovalPanel } from './ai-approval-panel';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiComposerSeatProps {
  readonly phase: 'hero' | 'active';
  readonly sessionKind: AiSessionKind;
  readonly status: AiSessionStatus;
  readonly presetLocked?: boolean;
  readonly defaultDraft?: string;
  readonly draft?: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  readonly contextLabel?: string;
  readonly permissionControl?: React.ReactNode;
  readonly composerState?: AiComposerState;
  readonly inbox?: readonly AiInboxItem[];
  readonly queueMutation?: AiQueueMutationState | null;
  readonly announcement?: string | null;
  readonly pendingApproval?: AiPendingApproval | null;
  readonly approvalDecision?: 'approve' | 'reject' | null;
  readonly approvalError?: string | null;
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
  readonly onSelectPreset?: (kind: AiSessionKind) => void;
  readonly onOpenProvider?: () => void;
  readonly onOpenModel?: () => void;
  readonly onOpenContext?: () => void;
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly onOpenApprovalDetails?: () => void;
}

export function AiComposerSeat({
  phase,
  sessionKind,
  status,
  presetLocked = false,
  defaultDraft = '',
  draft: controlledDraft,
  providerLabel,
  modelLabel,
  contextLabel,
  permissionControl,
  composerState,
  inbox = [],
  queueMutation = null,
  announcement,
  pendingApproval,
  approvalDecision = null,
  approvalError = null,
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
  onSelectPreset,
  onOpenProvider,
  onOpenModel,
  onOpenContext,
  onApprove,
  onReject,
  onOpenApprovalDetails,
}: AiComposerSeatProps): React.ReactNode {
  const { t } = useI18n();
  const [localDraft, setLocalDraft] = useState(defaultDraft);
  const draft = composerState?.draft ?? controlledDraft ?? localDraft;
  const running = status === 'running' || status === 'waiting';
  const waitingApproval = composerState?.phase === 'waitingApproval';
  const submitting = composerState?.phase === 'submitting';
  const terminal = composerState?.terminal ?? false;
  const empty = draft.trim().length === 0;
  const stopPrimary = running && empty;
  const runningAskBlocked = running && sessionKind === 'ask' && !empty;
  const submitDisabled = terminal
    || waitingApproval
    || submitting
    || runningAskBlocked
    || (stopPrimary ? onStop === undefined : empty || (onSubmitGesture === undefined && onSubmit === undefined));
  const presetLabel = sessionKind === 'agent' ? t('ai.mode.agent') : t('ai.mode.ask');
  const resolvedProviderLabel = providerLabel ?? t('ai.workspace.providerUnspecified');
  const resolvedModelLabel = modelLabel ?? t('ai.modelMissing');
  const toolsLabel = t('ai.workspace.composerTools');

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
  const busyPreference = composerState?.preferredBusyMode ?? 'queue';
  const primaryLabel = stopPrimary
    ? t('ai.workspace.stop')
    : running && sessionKind === 'agent'
      ? busyPreference === 'queue'
        ? t('ai.workspace.queue.action')
        : t('ai.workspace.steer.action')
      : t('ai.send');

  return (
    <div
      data-slot="ai-composer-seat"
      data-composer-seat=""
      data-phase={phase}
      className={cn(
        'relative min-w-0 shrink-0 px-3 pb-3 pt-2 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5',
        phase === 'active' && 'before:pointer-events-none before:absolute before:inset-x-0 before:-top-9 before:h-9 before:bg-linear-to-b before:from-transparent before:to-background',
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <AiQueueDock
          items={inbox}
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
      <InputGroup className="min-h-24 rounded-3xl bg-card shadow-xs has-[[data-slot=input-group-control]:focus-visible]:ring-1">
        <InputGroupTextarea
          data-testid="ai-workspace-composer"
          value={draft}
          disabled={waitingApproval}
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter'
              || event.shiftKey
              || event.nativeEvent.isComposing
              || event.keyCode === 229
              || event.repeat
            ) return;
            event.preventDefault();
            submit('keyboard', event.metaKey || event.ctrlKey);
          }}
          placeholder={sessionKind === 'agent' ? t('agent.placeholder') : t('ai.askPlaceholder')}
          className="min-h-13 max-h-[336px] px-4 pb-1 pt-3 leading-5"
        />
        <InputGroupAddon align="block-end" className="min-w-0 justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <DropdownMenuTrigger
                      render={(
                        <Button
                          variant="ghost"
                          size="sm"
                          className="max-w-32 shrink-0 rounded-full px-2"
                          aria-label={toolsLabel}
                        />
                      )}
                    />
                  )}
                >
                  <BotIcon data-icon="inline-start" />
                  <span className="truncate @max-[400px]/ai-workspace:sr-only">{presetLabel}</span>
                  <ChevronDownIcon data-icon="inline-end" />
                </TooltipTrigger>
                <TooltipContent>{toolsLabel}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('ai.mode')}</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={!onSelectPreset || presetLocked}
                    onClick={() => onSelectPreset?.('ask')}
                  >
                    <BotIcon />
                    {t('ai.mode.ask')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!onSelectPreset || presetLocked}
                    onClick={() => onSelectPreset?.('agent')}
                  >
                    <BrainCircuitIcon />
                    {t('ai.mode.agent')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('ai.workspace.sessionConfiguration')}</DropdownMenuLabel>
                  <DropdownMenuItem disabled={!onOpenProvider} onClick={onOpenProvider}>
                    <ServerIcon />
                    <span className="min-w-0 flex-1 truncate">{resolvedProviderLabel}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!onOpenModel} onClick={onOpenModel}>
                    <CpuIcon />
                    <span className="min-w-0 flex-1 truncate">{resolvedModelLabel}</span>
                  </DropdownMenuItem>
                  {contextLabel && (
                    <DropdownMenuItem disabled={!onOpenContext} onClick={onOpenContext}>
                      <PaperclipIcon />
                      <span className="min-w-0 flex-1 truncate">{contextLabel}</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="hidden min-w-0 truncate text-xs text-muted-foreground @min-[400px]/ai-workspace:inline @min-[560px]/ai-workspace:max-w-44">
              {resolvedProviderLabel} · {resolvedModelLabel}
            </span>
            {sessionKind === 'agent' && permissionControl}
            {running && sessionKind === 'agent' && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <DropdownMenuTrigger
                        render={(
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 rounded-full px-2"
                            aria-label={t('ai.workspace.busyPreference')}
                          />
                        )}
                      />
                    )}
                  >
                    {busyPreference === 'queue'
                      ? <ListPlusIcon data-icon="inline-start" />
                      : <CornerUpLeftIcon data-icon="inline-start" />}
                    <span className="@max-[400px]/ai-workspace:sr-only">
                      {busyPreference === 'queue'
                        ? t('ai.workspace.queue.action')
                        : t('ai.workspace.steer.action')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {busyPreference === 'queue'
                      ? t('ai.workspace.queue.tooltip')
                      : t('ai.workspace.steer.tooltip')}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
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

          {running && !stopPrimary && onStop && (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    className="size-9 shrink-0 rounded-full"
                    onClick={onStop}
                    aria-label={t('ai.workspace.stop')}
                  />
                )}
              >
                <SquareIcon />
              </TooltipTrigger>
              <TooltipContent>{t('ai.workspace.stopTooltip')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={(
                <InputGroupButton
                  variant={sessionKind === 'agent' ? 'warning' : 'default'}
                  size="icon-sm"
                  className="size-9 shrink-0 rounded-full"
                  onClick={() => submit('primary')}
                  disabled={submitDisabled}
                  aria-label={primaryLabel}
                />
              )}
            >
              {stopPrimary ? <SquareIcon /> : <ArrowUpIcon />}
            </TooltipTrigger>
            <TooltipContent>
              {waitingApproval
                ? t('ai.workspace.approvalWaiting')
                : terminal
                  ? t('ai.workspace.sessionEnded')
                : runningAskBlocked
                  ? t('ai.workspace.askRunningBlocked')
                  : primaryLabel}
            </TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement ? t(`ai.workspace.announce.${announcement}` as LocaleKey) : null}
      </span>
    </div>
  );
}

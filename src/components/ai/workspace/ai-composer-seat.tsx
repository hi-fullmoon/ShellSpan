import { useFileCompletion } from './use-file-completion';
import { useSkillCompletion } from './use-skill-completion';
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { getPlatform } from '@/lib/platform';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiContextUsage, AiInboxItem, AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionPlanStep } from '@/types/agent-session';
import { AiApprovalPanel } from './ai-approval-panel';
import { AiQuestionPanel } from './ai-question-panel';
import { questionKey } from '@/types/agent-question';
import { AiContextMeter } from './ai-context-meter';
import { AiQueueDock } from './ai-queue-dock';
import { AiTaskStrip } from './ai-task-strip';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiComposerSeatProps {
  readonly imageControls?: React.ReactNode;
  readonly onPasteImages?: (files: File[]) => void | Promise<void>;
  readonly hasImages?: boolean;
  readonly imageBusy?: boolean;
  readonly imageLocked?: boolean;
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
  readonly queueMutable?: boolean;
  readonly queueMutation?: AiQueueMutationState | null;
  readonly announcement?: string | null;
  readonly pendingApproval?: AiPendingApproval | null;
  readonly pendingQuestion?: import('@/types/agent-question').AgentQuestionView | null;
  readonly onListFileReferences?: import('@/types/agent-file-reference').ListFileReferences;
  readonly onListSkills?: (root?: string) => Promise<import('@/types/agent-skill').SkillUserList>;
  readonly skillsScopeKey?: string;
  readonly skillsNeedsRoot?: boolean;
  readonly projectTargetLabel?: string;
  readonly onAnswerQuestion?: (input: import('@/types/agent-question').AnswerQuestionInput) => Promise<void>;
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
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
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
  imageControls, onPasteImages, hasImages = false, imageBusy = false, imageLocked = false,
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
  queueMutable = true,
  announcement,
  pendingApproval,
  pendingQuestion,
  onAnswerQuestion,
  onListFileReferences,
  onListSkills,
  skillsScopeKey,
  skillsNeedsRoot,
  projectTargetLabel,
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
  onSteerQueueItem,
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
  const waitingQuestion = Boolean(pendingQuestion) || composerState?.phase === 'waitingQuestion';
  const submitting = composerState?.phase === 'submitting' || imageBusy;
  const terminal = composerState?.terminal ?? false;
  const unavailable = unavailableReason !== null;
  const empty = draft.trim().length === 0 && !hasImages;
  const stopPrimary = running && empty;
  const submitDisabled = terminal
    || waitingQuestion
    || waitingApproval
    || submitting
    || (stopPrimary
      ? onStop === undefined
      : unavailable || empty || (onSubmitGesture === undefined && onSubmit === undefined));
  const busyPreference = composerState?.preferredBusyMode ?? 'queue';
  const primaryLabel = imageLocked && !imageBusy ? t('common.retry') : stopPrimary
    ? t('ai.workspace.stop')
    : running
      ? busyPreference === 'queue'
        ? t('ai.workspace.queue.action')
        : t('ai.workspace.steer.action')
      : t('ai.send');
  const queueItems = useMemo<readonly AiInboxItem[]>(() => {
    const items = inbox.filter((item) => item.state !== 'claimed' && !item.startsTurn);
    for (const pending of composerState?.pendingSubmissions ?? []) {
      if (pending.mode === 'start' || pending.startsTurn) continue;
      if (inbox.some((item) => (
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
  const completion = useFileCompletion({ text: draft, update: updateDraft, query: onListFileReferences, scopeKey: skillsScopeKey, needsRoot: skillsNeedsRoot, targetLabel: projectTargetLabel, disabled: Boolean(terminal || waitingApproval || waitingQuestion || unavailable || imageLocked || submitting) });
  const skillCompletion = useSkillCompletion({ text: draft, update: updateDraft, query: onListSkills, scopeKey: skillsScopeKey, editor: completion.editor, disabled: Boolean(terminal || waitingApproval || waitingQuestion || unavailable || imageLocked || submitting) });
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
      {completion.dialog}
      <AiQueueDock
        items={queueItems}
        mutation={queueMutation}
        running={status === 'running'}
        mutable={queueMutable && !['completed', 'cancelled', 'failed'].includes(status)}
        onUpdate={onUpdateQueueItem}
        onRemove={onRemoveQueueItem}
        onSteer={onSteerQueueItem}
        onReorder={onReorderQueueLane}
        onRetry={onRetryQueueMutation}
      />
      {pendingQuestion && <AiQuestionPanel key={questionKey(pendingQuestion.identity)} question={pendingQuestion} onAnswer={onAnswerQuestion} />}
      {waitingQuestion && <Alert><AlertTitle>{t('ai.workspace.question.pending')}</AlertTitle><AlertDescription>{t('ai.workspace.announce.waitingQuestion')}</AlertDescription>{onStop && <Button type="button" variant="outline" onClick={onStop}>{t('ai.workspace.stop')}</Button>}</Alert>}
      {skillCompletion.panel}
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
            {...completion.textareaProps}
            {...(skillCompletion.open ? {
              'aria-controls': skillCompletion.textareaProps['aria-controls'],
              'aria-expanded': true,
              'aria-activedescendant': skillCompletion.textareaProps['aria-activedescendant'],
            } : {})}
            onSelect={event => { completion.textareaProps.onSelect(event); skillCompletion.textareaProps.onSelect(event); }}
            onFocus={event => { completion.textareaProps.onFocus(event); skillCompletion.textareaProps.onFocus(event); }}
            onBlur={() => { completion.textareaProps.onBlur(); skillCompletion.textareaProps.onBlur(); }}
            data-testid="ai-workspace-composer"
            value={draft}
            disabled={waitingApproval || waitingQuestion || unavailable || imageLocked}
            onChange={(event) => { updateDraft(event.target.value); completion.changed(event.target); skillCompletion.changed(event.target); }}
            onPaste={(event) => {
              if (!onPasteImages) return;
              const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
              if (!files.length) {
                for (const item of Array.from(event.clipboardData.items)) {
                  if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
                  const file = item.getAsFile();
                  if (file) files.push(file);
                }
              }
              if (!files.length) return;
              event.preventDefault();
              if (terminal || waitingApproval || waitingQuestion || unavailable || submitting || imageLocked) return;
              void onPasteImages(files);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
              completion.composition(true);
              skillCompletion.composition(true);
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              completion.composition(false);
              skillCompletion.composition(false);
              composingUntilRef.current = Date.now() + 10;
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing
                || event.keyCode === 229
                || composingRef.current
                || Date.now() < composingUntilRef.current
              ) return;
              if (skillCompletion.keyDown(event) || completion.keyDown(event)) return;
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              if (event.repeat) return;
              submit('keyboard', event.metaKey || event.ctrlKey);
            }}
            placeholder={t('ai.workspace.composerPlaceholder', { pasteShortcut: getPlatform() === 'macos' ? '⌘V' : 'Ctrl+V' })}
          />
          {completion.panel && <InputGroupAddon align="block-start" className="block min-w-0">{completion.panel}</InputGroupAddon>}
          {imageControls && <InputGroupAddon align="block-start" className="ai-image-draft-addon block min-w-0">{imageControls}</InputGroupAddon>}
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
                  <DropdownMenuContent className="ai-busy-preference-menu" side="top" sideOffset={8} align="start">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="px-2.5 py-2">{t('ai.workspace.busyPreference')}</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={busyPreference}
                        onValueChange={(value) => {
                          if (value === 'queue' || value === 'steer') onBusyPreferenceChange?.(value);
                        }}
                      >
                        <DropdownMenuRadioItem className="min-h-10 gap-2 py-2 pl-2.5 whitespace-nowrap" value="queue">
                          <ListPlusIcon />
                          {t('ai.workspace.queue.action')}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem className="min-h-10 gap-2 py-2 pl-2.5 whitespace-nowrap" value="steer">
                          <CornerUpLeftIcon />
                          {t('ai.workspace.steer.action')}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
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

import { AiComposerEditor } from './ai-composer-editor';
import { AiCompletionPopover } from './ai-completion-popover';
import { useFileCompletion } from './use-file-completion';
import { useSkillCompletion } from './use-skill-completion';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  InfoIcon,
  ListPlusIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
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
} from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
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
import { AiErrorNotice } from './ai-error-notice';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiComposerSeatProps {
  readonly mode?: 'ask' | 'agent';
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
  readonly executionSurfaceControl?: React.ReactNode;
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
  readonly onRetryTurn?: () => void;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
  readonly onResumeQueueItem?: (item: AiInboxItem) => void;
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
  mode = 'agent',
  imageControls, onPasteImages, hasImages = false, imageBusy = false, imageLocked = false,
  phase,
  status,
  defaultDraft = '',
  draft: controlledDraft,
  modelLabel,
  modelControl,
  contextUsage,
  permissionControl,
  executionSurfaceControl,
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
  onRetryTurn,
  onBusyPreferenceChange,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onSteerQueueItem,
  onResumeQueueItem,
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
  const availabilityHintId = useId();
  const [localDraft, setLocalDraft] = useState(defaultDraft);
  const composingRef = useRef(false);
  const composingUntilRef = useRef(0);
  const completionAnchor = useRef<HTMLDivElement>(null);
  const draft = composerState?.draft ?? controlledDraft ?? localDraft;
  const running = status === 'running' || status === 'waiting';
  const waitingApproval = mode === 'agent' && composerState?.phase === 'waitingApproval';
  const waitingQuestion = Boolean(pendingQuestion) || composerState?.phase === 'waitingQuestion';
  const submitting = composerState?.phase === 'submitting' || imageBusy;
  const terminal = composerState?.terminal ?? false;
  const stopping = composerState?.phase === 'stopping';
  const unavailable = unavailableReason !== null;
  const empty = draft.trim().length === 0 && !hasImages;
  const stopPrimary = running && empty;
  const submitDisabled = terminal
    || stopping
    || waitingQuestion
    || waitingApproval
    || submitting
    || (mode === 'ask' && running && !empty)
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
  const wasStopping = useRef(false);
  useEffect(() => {
    if (wasStopping.current && !stopping) {
      completion.editor.current?.element?.focus({ preventScroll: true });
      completion.editor.current?.focus();
    }
    wasStopping.current = stopping;
  }, [stopping, completion.editor]);
  const submit = (gesture: 'keyboard' | 'primary', accelerated = false): void => {
    if (submitDisabled) return;
    if (stopPrimary) {
      if (gesture === 'primary') onStop?.();
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
      data-ai-mode={mode}
      className="ai-composer-seat relative mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] shrink-0 flex-col gap-[var(--ai-composer-stack-gap)] px-[var(--ai-shell-clearance)] py-2"
    >
      {mode === 'agent' && <AiTaskStrip steps={taskSteps} />}
      <div className="ai-composer-notices flex min-w-0 flex-col gap-1.5 empty:hidden">
        {status === 'failed' && onRetryTurn && !terminal && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-center rounded-full"
            disabled={stopping || submitting || unavailable}
            onClick={onRetryTurn}
          >
            <RotateCcwIcon data-icon="inline-start" />
            {t('ai.workspace.retryTurn')}
          </Button>
        )}
        {waitingApproval && !pendingApproval && (
          <Alert size="sm">
            <AlertTitle>{t('ai.workspace.approvalWaiting')}</AlertTitle>
            <AlertDescription>{t('ai.workspace.approvalPhase5')}</AlertDescription>
          </Alert>
        )}
        {composerState?.lastError && (
          <AiErrorNotice
            title={t('ai.workspace.recovery.title')}
            action={onDismissError && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('ai.workspace.recovery.dismiss')}
                onClick={onDismissError}
              >
                <XIcon />
              </Button>
            )}
          >
            {composerState.lastError.message}
          </AiErrorNotice>
        )}
        {composerState?.failedDrafts.map((failed) => (
          <AiErrorNotice
            key={failed.id}
            title={t('ai.workspace.recovery.title')}
            label={t('ai.workspace.failedDraft')}
            action={(
              <Button
                variant="ghost"
                size="xs"
                disabled={submitting || !failed.error.retryable}
                onClick={() => onRetryFailedDraft?.(failed.id)}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {t('common.retry')}
              </Button>
            )}
          >
            {failed.content}
          </AiErrorNotice>
        ))}
      </div>
      {stopping && <Alert size="sm" variant="subtle" role="status"><AlertDescription>{t('ai.workspace.stopping')}</AlertDescription></Alert>}
      {completion.dialog}
      {mode === 'agent' && <AiQueueDock
        items={queueItems}
        mutation={queueMutation}
        running={status === 'running'}
        mutable={!stopping && queueMutable && !['completed', 'cancelled', 'failed'].includes(status)}
        onUpdate={onUpdateQueueItem}
        onRemove={onRemoveQueueItem}
        onSteer={onSteerQueueItem}
        onResume={onResumeQueueItem}
        onReorder={onReorderQueueLane}
        onRetry={onRetryQueueMutation}
      />}
      {pendingQuestion && <AiQuestionPanel key={questionKey(pendingQuestion.identity)} question={pendingQuestion} onAnswer={onAnswerQuestion} />}
      {waitingQuestion && !pendingQuestion && <Alert><AlertTitle>{t('ai.workspace.question.pending')}</AlertTitle><AlertDescription>{t('ai.workspace.announce.waitingQuestion')}</AlertDescription>{onStop && <Button type="button" variant="outline" onClick={onStop}>{t('ai.workspace.stop')}</Button>}</Alert>}
      {waitingApproval && pendingApproval && (
        <AiApprovalPanel
          approval={pendingApproval}
          decision={approvalDecision}
          error={approvalError}
          onApprove={() => onApprove?.()}
          onReject={() => onReject?.()}
          onOpenDetails={() => onOpenApprovalDetails?.()}
        />
      )}
      {
        <div ref={completionAnchor} className="ai-composer-input-anchor relative min-w-0">
          <InputGroup className="h-auto flex-col items-stretch gap-3 overflow-hidden pt-2.5" data-composer-card="" onClick={event => {
            if (event.target === event.currentTarget) completion.editor.current?.focus();
          }}>
            <AiComposerEditor
              {...completion.editorProps}
              {...(skillCompletion.open ? {
                'aria-controls': skillCompletion.editorProps['aria-controls'],
                'aria-expanded': true,
                'aria-activedescendant': skillCompletion.editorProps['aria-activedescendant'],
              } : {})}
              commandNames={skillCompletion.commandNames}
              onSelectionChange={() => { completion.editorProps.onSelectionChange(); skillCompletion.editorProps.onSelectionChange(); }}
              onFocus={() => { completion.editorProps.onFocus(); skillCompletion.editorProps.onFocus(); }}
              onBlur={() => { completion.editorProps.onBlur(); skillCompletion.editorProps.onBlur(); }}
              data-testid="ai-workspace-composer"
              className={cn(
                'mr-1 w-[calc(100%-4px)] shrink-0 resize-none overflow-y-auto pt-1 pr-2 pb-0 pl-4 [field-sizing:content] max-h-[min(336px,42vh)]',
                phase === 'hero' ? 'min-h-13' : 'min-h-7',
              )}
              aria-describedby={unavailableReason ? availabilityHintId : undefined}
              value={draft}
              historyKey={JSON.stringify([composerState?.sessionId, skillsScopeKey])}
              onChange={updateDraft}
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
                  event.isComposing
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
              placeholder={mode === 'ask'
                ? t('ai.workbench.composerPlaceholder')
                : t('ai.workspace.composerPlaceholder', { pasteShortcut: getPlatform() === 'macos' ? '⌘V' : 'Ctrl+V' })}
            />
            {imageControls && <InputGroupAddon align="block-start" className="ai-image-draft-addon block min-w-0 px-3">{imageControls}</InputGroupAddon>}
            <InputGroupAddon align="block-end" className="ai-composer-toolbar min-h-10.5 min-w-0 justify-between gap-3 px-2 pt-0.5 pb-1.5 @max-[400px]/ai-workspace:gap-1 @max-[400px]/ai-workspace:px-[7px]" onClick={event => {
              if (!(event.target as HTMLElement).closest('button, [role="button"]')) completion.editor.current?.focus();
            }}>
              <div className="ai-composer-tools flex min-w-0 shrink-0 items-center gap-1">
                {mode === 'ask' ? (
                  <span className="ai-composer-mode-note flex min-w-0 items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
                    <ShieldCheckIcon aria-hidden="true" />
                    {t('ai.workbench.capabilityNote')}
                  </span>
                ) : permissionControl}
                {mode === 'agent' && executionSurfaceControl}
                {mode === 'agent' && running && (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger
                        render={(
                          <DropdownMenuTrigger
                            render={(
                              <Button
                                variant="ghost"
                                size="xs"
                                className="ai-busy-preference-trigger h-7 min-w-0 @max-[640px]/ai-workspace:size-7 @max-[640px]/ai-workspace:shrink-0 @max-[640px]/ai-workspace:p-0 @max-[640px]/ai-workspace:[&_[data-icon=inline-end]]:hidden"
                                aria-label={t('ai.workspace.busyPreference')}
                              />
                            )}
                          />
                        )}
                      >
                        {busyPreference === 'queue'
                          ? <ListPlusIcon data-icon="inline-start" />
                          : <CornerUpLeftIcon data-icon="inline-start" />}
                        <span className="ai-busy-preference-label min-w-0 truncate @max-[640px]/ai-workspace:hidden">
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
                    <DropdownMenuContent className="ai-busy-preference-menu w-max min-w-[200px] max-w-[calc(100vw-16px)] p-[3px]" side="top" sideOffset={8} align="start">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="px-2 py-[5px]">{t('ai.workspace.busyPreference')}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={busyPreference}
                          onValueChange={(value) => {
                            if (value === 'queue' || value === 'steer') onBusyPreferenceChange?.(value);
                          }}
                        >
                          <DropdownMenuRadioItem className="min-h-[34px] gap-1.5 py-[5px] pl-2 whitespace-nowrap" value="queue">
                            <ListPlusIcon />
                            {t('ai.workspace.queue.action')}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem className="min-h-[34px] gap-1.5 py-[5px] pl-2 whitespace-nowrap" value="steer">
                            <CornerUpLeftIcon />
                            {t('ai.workspace.steer.action')}
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>

              <div className="ai-composer-trailing flex min-w-0 flex-1 basis-0 items-center justify-end gap-1.5 @max-[400px]/ai-workspace:gap-[3px]">
                {modelControl ?? (modelLabel && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ai-model-trigger h-7 min-w-0 max-w-full flex-[0_1_auto] gap-1 overflow-hidden pr-1.5 pl-2"
                    disabled={!onOpenModel}
                    onClick={onOpenModel}
                    aria-label={t('ai.workspace.model.trigger', { selection: modelLabel })}
                  >
                    <span className="ai-model-trigger-name min-w-0 max-w-60 flex-[0_1_auto] truncate">{modelLabel}</span>
                    <ChevronDownIcon data-icon="inline-end" />
                  </Button>
                ))}
                <AiContextMeter usage={contextUsage} />
                {running && !stopping && !stopPrimary && onStop && (
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <InputGroupButton
                          variant="ghost"
                          size="icon-sm"
                          className="ai-composer-primary ai-composer-stop size-8 shrink-0"
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
                        className="ai-composer-primary size-8 shrink-0"
                        onClick={() => submit('primary')}
                        disabled={submitDisabled}
                        aria-label={primaryLabel}
                        aria-describedby={unavailableReason ? availabilityHintId : undefined}
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
          <AiCompletionPopover anchor={completionAnchor} onDismiss={() => {
            skillCompletion.dismiss();
            completion.dismiss();
          }}>
            {skillCompletion.panel ?? completion.panel}
          </AiCompletionPopover>
        </div>
      }
      {unavailableReason && (
        <Alert
          id={availabilityHintId}
          variant="subtle"
          size="sm"
          role="status"
          aria-label={t('agent.availability.title')}
          className="mx-2 w-auto"
        >
          <InfoIcon aria-hidden="true" />
          <AlertDescription className="min-w-0 break-words">{unavailableReason}</AlertDescription>
        </Alert>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement ? t(`ai.workspace.announce.${announcement}` as LocaleKey) : null}
      </span>
    </div>
  );
}

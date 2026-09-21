import { AiComposerEditor } from './ai-composer-editor';
import { AiCompletionPopover } from './ai-completion-popover';
import { useFileCompletion } from './use-file-completion';
import { useSkillCompletion } from './use-skill-completion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  ListPlusIcon,
  ShieldCheckIcon,
  SquareIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
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
import { formatFileMention } from '@/lib/ai/file-reference-grammar';
import { invokeListLocalDirectory, invokePickLocalFiles, invokePreviewLocalFile, isTauriRuntime } from '@/lib/ipc/tauri';
import { useToast } from '@/hooks/useToast';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiContextUsage, AiInboxItem, AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionPlanStep } from '@/types/agent-session';
import { AiApprovalPanel } from './ai-approval-panel';
import { AiQuestionPanel } from './ai-question-panel';
import { questionKey } from '@/types/agent-question';
import { AiContextMeter } from './ai-context-meter';
import { AiQueueDock } from './ai-queue-dock';
import { useDocumentImport } from './use-document-import';
import { DOCUMENT_ACCEPT, IMAGE_ACCEPT, documentErrorKey, isDocumentName } from '@/lib/ai/document-import';
import { decodeDocumentMessage, encodeDocumentMessage } from '@/lib/ai/document-message';
import { AiDocumentAttachments } from './ai-document-attachments';
import { AiDraftAttachmentRail, UnifiedAttachmentContext } from './ai-image-draft-rail';
import { AiTaskStrip } from './ai-task-strip';
import { AiComposerAddMenu, type ComposerHistoryProps } from './ai-composer-add-menu';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiComposerSeatProps extends ComposerHistoryProps {
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
  readonly attachmentScopeKey?: string;
  readonly skillsNeedsRoot?: boolean;
  readonly projectTargetLabel?: string;
  readonly onAnswerQuestion?: (input: import('@/types/agent-question').AnswerQuestionInput) => Promise<void>;
  readonly approvalDecision?: 'approve' | 'reject' | null;
  readonly approvalError?: string | null;
  readonly approvalArguments?: unknown | null;
  readonly approvalArgumentsLoading?: boolean;
  readonly approvalArgumentsError?: string | null;
  readonly unavailableReason?: string | null;
  readonly availabilityHintId?: string;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
  readonly onResumeQueueItem?: (item: AiInboxItem) => void;
  readonly onReorderQueueLane?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onOpenModel?: () => void;
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly onOpenApprovalDetails?: () => void;
}

/** ShellSpan composer surface backed by the existing workspace state machine. */
export function AiComposerSeat({
  mode = 'agent',
  sessions, sessionsLoading, sessionsError, currentSessionId, onRefreshSessions, onReadSession,
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
  attachmentScopeKey,
  skillsNeedsRoot,
  projectTargetLabel,
  approvalDecision = null,
  approvalError = null,
  approvalArguments = null,
  approvalArgumentsLoading = false,
  approvalArgumentsError = null,
  unavailableReason = null,
  availabilityHintId,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onBusyPreferenceChange,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onSteerQueueItem,
  onResumeQueueItem,
  onReorderQueueLane,
  onOpenModel,
  onApprove,
  onReject,
  onOpenApprovalDetails,
}: AiComposerSeatProps): React.ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const cardRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [localDraft, setLocalDraft] = useState(defaultDraft);
  const composingRef = useRef(false);
  const composingUntilRef = useRef(0);
  const completionAnchor = useRef<HTMLDivElement>(null);
  const rawDraft = composerState?.draft ?? controlledDraft ?? localDraft;
  const rawDraftRef = useRef(rawDraft);
  rawDraftRef.current = rawDraft;
  const attachmentOwner = JSON.stringify([mode, attachmentScopeKey, composerState?.sessionId, skillsScopeKey]);
  const attachmentOwnerRef = useRef(attachmentOwner);
  attachmentOwnerRef.current = attachmentOwner;
  const message = useMemo(() => decodeDocumentMessage(rawDraft), [rawDraft]);
  const chatReferences = useRef({ owner: attachmentOwner, documents: new Map<string, (typeof message.documents)[number]>() });
  if (chatReferences.current.owner !== attachmentOwner) {
    chatReferences.current = { owner: attachmentOwner, documents: new Map() };
  }
  for (const document of message.documents) {
    if (document.chatTitle !== undefined) chatReferences.current.documents.set(document.id, document);
  }
  const fileDocuments = message.documents.filter(document => document.chatTitle === undefined);
  const missingChatTitles = message.documents.flatMap(document => document.chatTitle && !message.text.includes(document.chatTitle) ? [document.chatTitle] : []);
  const draft = missingChatTitles.length ? `${[message.text, ...missingChatTitles].filter(Boolean).join(' ')} ` : message.text;
  const running = status === 'running' || status === 'waiting';
  const waitingApproval = mode === 'agent' && composerState?.phase === 'waitingApproval';
  const waitingQuestion = Boolean(pendingQuestion) || composerState?.phase === 'waitingQuestion';
  const submitting = composerState?.phase === 'submitting' || imageBusy;
  const terminal = composerState?.terminal ?? false;
  const stopping = composerState?.phase === 'stopping';
  const unavailable = unavailableReason !== null;
  const updateRawDraft = (value: string): void => {
    rawDraftRef.current = value;
    if (composerState === undefined && controlledDraft === undefined) setLocalDraft(value);
    onDraftChange?.(value);
  };
  const updateDraft = (value: string): void => {
    try {
      const files = decodeDocumentMessage(rawDraftRef.current).documents.filter(document => document.chatTitle === undefined);
      const references = [...chatReferences.current.documents.values()].filter(document => document.chatTitle && value.includes(document.chatTitle));
      updateRawDraft(encodeDocumentMessage(value, [...files, ...references], false));
    }
    catch (error) { toast.error(t(documentErrorKey(error))); }
  };
  const documents = useDocumentImport(
    attachmentOwner,
    rawDraft, updateRawDraft, terminal || waitingApproval || waitingQuestion || unavailable || submitting || imageLocked,
  );
  const empty = draft.trim().length === 0 && !hasImages && !message.documents.length;
  const stopPrimary = running && empty;
  const submitDisabled = terminal
    || stopping
    || submitting
    || documents.busy
    || (!stopPrimary && (waitingQuestion || waitingApproval))
    || (mode === 'ask' && running && !empty)
    || (stopPrimary
      ? onStop === undefined
      : unavailable || empty || (onSubmitGesture === undefined && onSubmit === undefined));
  const busyPreference = composerState?.preferredBusyMode ?? 'queue';
  const primaryLabel = submitting
    ? t('ai.workspace.messagePending')
    : stopPrimary
      ? t('ai.workspace.stop')
      : running
        ? busyPreference === 'queue'
          ? t('ai.workspace.queue.action')
          : t('ai.workspace.steer.action')
        : t('ai.send');
  const queueItems = useMemo<readonly AiInboxItem[]>(() => {
    // Internal context (for example after-tool verification reminders) is
    // consumed between steps and must not briefly expand the user's queue.
    const items = inbox.filter((item) => (
      item.source === 'user' && item.state !== 'claimed' && !item.startsTurn
    ));
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

  const attachmentsEnabled = !terminal && !waitingApproval && !waitingQuestion && !unavailable && !submitting && !imageLocked && !documents.busy;
  const addPaths = async (paths: readonly string[], kind?: 'file' | 'directory'): Promise<void> => {
    if (!attachmentsEnabled || !paths.length || attachmentOwnerRef.current !== attachmentOwner) return;
    try {
      const imagePaths = kind !== 'directory' && onPasteImages
        ? paths.filter(path => /\.(png|jpe?g|webp|gif)$/iu.test(path)) : [];
      const referencePaths = paths.filter(path => !imagePaths.includes(path));
      if (imagePaths.length) {
        const files = await Promise.all(imagePaths.map(async path => {
          const preview = await invokePreviewLocalFile(path);
          if (preview.truncated || preview.contentEncoding !== 'base64') throw new Error(t('ai.workspace.images.error.invalid'));
          const binary = atob(preview.content);
          const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
          const extension = path.split('.').pop()?.toLowerCase();
          const mediaType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg';
          return new File([bytes], preview.name, { type: mediaType });
        }));
        if (attachmentOwnerRef.current !== attachmentOwner) return;
        await onPasteImages?.(files);
      }
      if (attachmentOwnerRef.current !== attachmentOwner) return;
      if (!referencePaths.length) return;
      if (mode === 'ask') throw new Error(t('ai.workspace.attachments.agentOnly'));
      const result = await onListFileReferences?.('', new AbortController().signal);
      const root = result?.scope?.root?.replace(/[/\\]+$/u, '').replace(/\\/gu, '/');
      if (!root || result?.scope?.target.kind !== 'local') throw new Error(t('ai.workspace.attachments.localOnly'));
      const mentions = await Promise.all(referencePaths.map(async path => {
        const normalized = path.replace(/\\/gu, '/');
        const relative = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null;
        if (!relative) return null;
        let resolvedKind = kind;
        if (!resolvedKind) resolvedKind = await invokeListLocalDirectory(path).then(() => 'directory' as const, () => 'file' as const);
        const mention = formatFileMention({ path: relative, kind: resolvedKind });
        return resolvedKind === 'directory' && mention?.startsWith('@"') ? `${mention}"` : mention;
      }));
      if (mentions.some(mention => !mention)) throw new Error(t('ai.workspace.attachments.outsideRoot'));
      if (attachmentOwnerRef.current !== attachmentOwner) return;
      const currentText = decodeDocumentMessage(rawDraftRef.current).text;
      updateDraft(`${currentText}${currentText && !/\s$/u.test(currentText) ? ' ' : ''}${mentions.join(' ')} `);
      completion.editor.current?.focus();
    } catch (error) { toast.error(String(error)); }
  };
  const addDroppedPaths = async (paths: readonly string[]) => {
    if (attachmentOwnerRef.current !== attachmentOwner) return;
    const documentPaths = paths.filter(isDocumentName);
    const otherPaths = paths.filter(path => !isDocumentName(path));
    if (documentPaths.length && !await documents.addPaths(documentPaths)) return;
    if (attachmentOwnerRef.current !== attachmentOwner) return;
    if (otherPaths.length) await addPaths(otherPaths);
  };
  const addBrowserFiles = (files: readonly File[]) => {
    if (!attachmentsEnabled) return;
    const images = files.filter(file => file.type.startsWith('image/'));
    const imported = files.filter(file => !file.type.startsWith('image/'));
    if (images.length && !onPasteImages) { toast.error(t('ai.workspace.images.error.model')); return; }
    const addImages = () => {
      if (images.length && attachmentOwnerRef.current === attachmentOwner) void onPasteImages?.(images);
    };
    if (imported.length) void documents.addFiles(imported).then(accepted => { if (accepted) addImages(); });
    else addImages();
  };
  const dropState = useRef({ attachmentsEnabled, addPaths: addDroppedPaths });
  dropState.current = { attachmentsEnabled, addPaths: addDroppedPaths };
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const listener = getCurrentWindow().onDragDropEvent(event => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.type === 'leave') { setDragActive(false); return; }
      const rect = cardRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const inside = Boolean(rect && payload.position.x / scale >= rect.left && payload.position.x / scale <= rect.right && payload.position.y / scale >= rect.top && payload.position.y / scale <= rect.bottom);
      if (payload.type === 'enter' || payload.type === 'over') setDragActive(inside && dropState.current.attachmentsEnabled);
      if (payload.type === 'drop') {
        setDragActive(false);
        if (inside && dropState.current.attachmentsEnabled) void dropState.current.addPaths(payload.paths);
      }
    });
    return () => { disposed = true; void listener.then(unlisten => unlisten()); };
  }, []);
  const uploadLocalFile = () => {
    if (isTauriRuntime()) void invokePickLocalFiles().then(paths => {
      if (attachmentOwnerRef.current !== attachmentOwner) return;
      if (paths.some(path => !isDocumentName(path) && !/\.(png|jpe?g|webp|gif)$/iu.test(path))) {
        toast.error(t('ai.workspace.documents.error.format')); return;
      }
      return addDroppedPaths(paths);
    }).catch(error => toast.error(String(error)));
    else documentInputRef.current?.click();
  };
  const referenceSession = onReadSession ? (summary: import('@/lib/ai/session-adapter').AiSessionSummary) => {
    if (attachmentOwnerRef.current !== attachmentOwner) return;
    void documents.addFrom(async signal => [await onReadSession(summary, signal)], summary.title);
  } : undefined;
  const completion = useFileCompletion({ text: draft, update: updateDraft, query: mode === 'agent' ? onListFileReferences : undefined, scopeKey: attachmentOwner, needsRoot: skillsNeedsRoot, targetLabel: projectTargetLabel, disabled: !attachmentsEnabled,
    context: { agent: mode === 'agent', onUpload: uploadLocalFile, onSession: referenceSession,
      sessions, sessionsLoading, sessionsError, currentSessionId: currentSessionId ?? composerState?.sessionId, onRefreshSessions },
  });
  const skillCompletion = useSkillCompletion({ text: draft, update: updateDraft, query: mode === 'agent' ? onListSkills : undefined, scopeKey: skillsScopeKey, editor: completion.editor, disabled: Boolean(terminal || waitingApproval || waitingQuestion || unavailable || imageLocked || submitting) });
  const wasStopping = useRef(false);
  const blockedSubmitReason = submitting ? 'ai.workspace.announce.submitting'
    : mode === 'ask' && running ? 'ai.workspace.announce.askRunning' : null;
  const announcedBlock = useRef<string | null>(null);
  useEffect(() => { announcedBlock.current = null; }, [blockedSubmitReason, attachmentOwner]);
  useEffect(() => {
    if (wasStopping.current && !stopping) {
      completion.editor.current?.element?.focus({ preventScroll: true });
      completion.editor.current?.focus();
    }
    wasStopping.current = stopping;
  }, [stopping, completion.editor]);
  const submit = (gesture: 'keyboard' | 'primary', accelerated = false): void => {
    if (submitDisabled) {
      if (gesture === 'keyboard' && !empty && blockedSubmitReason && announcedBlock.current !== blockedSubmitReason) {
        announcedBlock.current = blockedSubmitReason;
        toast.info(t(blockedSubmitReason));
      }
      return;
    }
    if (stopPrimary) {
      if (gesture === 'primary') onStop?.();
      return;
    }
    try { encodeDocumentMessage(draft, message.documents); }
    catch (error) { toast.error(t(documentErrorKey(error))); return; }
    // Focus synchronously while the user's gesture still owns focus. A later
    // receipt must never pull focus away from another control or the terminal.
    completion.editor.current?.element?.focus({ preventScroll: true });
    completion.editor.current?.focus();
    if (onSubmitGesture) onSubmitGesture(gesture, accelerated);
    else void onSubmit?.(rawDraft);
  };

  return (
    <div
      data-slot="ai-composer-seat"
      data-composer-seat=""
      data-phase={phase}
      data-ai-mode={mode}
      className="ai-composer-seat relative mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] shrink-0 flex-col gap-[var(--ai-composer-stack-gap)] px-[var(--ai-shell-clearance)] py-2"
    >
      {mode === 'agent' && (
        <AiTaskStrip steps={taskSteps} active={status === 'running' || status === 'waiting'} />
      )}
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
      />}
      {pendingQuestion && <AiQuestionPanel key={questionKey(pendingQuestion.identity)} question={pendingQuestion} onAnswer={onAnswerQuestion} />}
      {
        <div ref={completionAnchor} className="ai-composer-input-anchor relative min-w-0">
          <InputGroup ref={cardRef} className={cn(
            'h-auto flex-col items-stretch gap-0 overflow-hidden',
            dragActive && 'ring-2 ring-primary',
            !imageControls && (phase === 'hero' ? 'pt-1.5' : 'pt-2.5'),
            waitingApproval && pendingApproval && 'invisible',
          )} data-composer-card="" aria-hidden={waitingApproval && pendingApproval ? true : undefined} onClick={event => {
            if (event.target === event.currentTarget) completion.editor.current?.focus();
          }} onDragOver={event => {
            if (!isTauriRuntime() && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragActive(attachmentsEnabled); }
          }} onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }} onDrop={event => {
            if (isTauriRuntime()) return;
            event.preventDefault(); setDragActive(false);
            if (!attachmentsEnabled) return;
            addBrowserFiles(Array.from(event.dataTransfer.files));
          }}>
            {dragActive && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/90 text-sm font-medium text-foreground" role="status">
              {t(mode === 'ask' ? 'ai.workspace.documents.drop' : 'ai.workspace.attachments.drop')}
            </div>}
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
              chatTitles={[...chatReferences.current.documents.values()].map(document => document.chatTitle!)}
              historyKey={JSON.stringify([composerState?.sessionId, skillsScopeKey])}
              onChange={updateDraft}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (!files.length) {
                  for (const item of Array.from(event.clipboardData.items)) {
                    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (!files.length) return;
                event.preventDefault();
                if (!attachmentsEnabled) return;
                addBrowserFiles(files);
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
                : t('ai.workspace.composerPlaceholder')}
            />
            {(imageControls || fileDocuments.length > 0 || documents.pending.length > 0) && <InputGroupAddon align="block-start" className="ai-image-draft-addon block min-w-0 px-3" onClick={event => event.stopPropagation()}>
              <UnifiedAttachmentContext value={true}>
              <AiDraftAttachmentRail unified count={fileDocuments.length + documents.pending.length}>
              {imageControls}
              <AiDocumentAttachments composer documents={fileDocuments} pending={documents.pending} locked={!attachmentsEnabled} onCancel={documents.cancel}
                onRemove={id => updateRawDraft(encodeDocumentMessage(draft, message.documents.filter(document => document.id !== id)))} />
              </AiDraftAttachmentRail>
              </UnifiedAttachmentContext>
            </InputGroupAddon>}
            <InputGroupAddon align="block-end" className="ai-composer-toolbar mt-3 min-h-10.5 min-w-0 justify-between gap-3 px-2 pt-0.5 pb-1.5 @max-[400px]/ai-workspace:gap-1 @max-[400px]/ai-workspace:px-[7px]" onClick={event => {
              // Portal menu clicks bubble through React without occurring inside the toolbar.
              if (!event.currentTarget.contains(event.target as Node)) return;
              if (!(event.target as HTMLElement).closest('button, [role="button"]')) completion.editor.current?.focus();
            }}>
              <div className="ai-composer-tools flex min-w-0 shrink-0 items-center gap-1">
                <input ref={documentInputRef} type="file" accept={`${DOCUMENT_ACCEPT},${IMAGE_ACCEPT}`} multiple className="sr-only" tabIndex={-1} aria-label={t('ai.workspace.attachments.file')} onChange={event => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  if (attachmentsEnabled && files.length) addBrowserFiles(files);
                }} />
                <AiComposerAddMenu key={attachmentOwner} disabled={!attachmentsEnabled} agent={mode === 'agent'} anchor={cardRef}
                  onAddFile={uploadLocalFile}
                  onAddFolder={() => completion.browse()}
                  onSkill={name => {
                    const current = decodeDocumentMessage(rawDraftRef.current).text;
                    updateDraft(`${current}${current && !/\s$/u.test(current) ? ' ' : ''}/${name} `);
                    requestAnimationFrame(() => { completion.editor.current?.focus(); completion.editor.current?.setSelectionRange(completion.editor.current.value.length, completion.editor.current.value.length); });
                  }}
                />
                {mode === 'ask' ? (
                  <span className="ai-composer-mode-note flex min-w-0 items-center gap-[4px] overflow-hidden text-ellipsis whitespace-nowrap">
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
                          <DropdownMenuRadioItem className="min-h-[34px] gap-1 py-[5px] pl-2 whitespace-nowrap" value="queue">
                            <ListPlusIcon />
                            {t('ai.workspace.queue.action')}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem className="min-h-[34px] gap-1 py-[5px] pl-2 whitespace-nowrap" value="steer">
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
                    className="ai-model-trigger h-7 min-w-0 max-w-full flex-[0_1_auto] overflow-hidden pr-1.5 pl-2"
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
                          className="ai-composer-primary ai-composer-stop size-7 shrink-0"
                          onClick={onStop}
                          aria-label={t('ai.workspace.stop')}
                        />
                      )}
                    >
                      <SquareIcon className="ai-composer-stop-icon" fill="currentColor" />
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
                        className="ai-composer-primary size-7 shrink-0"
                        onClick={() => submit('primary')}
                        disabled={submitDisabled}
                        aria-label={primaryLabel}
                        aria-busy={submitting || undefined}
                        aria-describedby={unavailableReason ? availabilityHintId : undefined}
                      />
                    )}
                  >
                    {submitting
                      ? <Spinner aria-hidden="true" />
                      : stopPrimary
                      ? <SquareIcon className="ai-composer-stop-icon" fill="currentColor" />
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
          {waitingApproval && pendingApproval && (
            <div
              data-slot="ai-approval-overlay"
              className="absolute inset-x-0 bottom-0"
            >
              <AiApprovalPanel
                approval={{
                  ...pendingApproval,
                  arguments: approvalArguments ?? pendingApproval.arguments,
                }}
                decision={approvalDecision}
                error={approvalError}
                argumentsLoading={approvalArgumentsLoading}
                argumentsError={approvalArgumentsError}
                onApprove={() => onApprove?.()}
                onReject={() => onReject?.()}
                onOpenDetails={() => onOpenApprovalDetails?.()}
              />
            </div>
          )}
          <AiCompletionPopover anchor={completionAnchor} fixedHeight={completion.open && !skillCompletion.open} onDismiss={() => {
            skillCompletion.dismiss();
            completion.dismiss();
          }}>
            {skillCompletion.panel ?? completion.panel}
          </AiCompletionPopover>
        </div>
      }
      <p className="m-0 shrink-0 text-center text-[11px] leading-4 text-[var(--ai-text-caption)] opacity-70" data-slot="ai-composer-disclaimer">
        {t('ai.workspace.composerDisclaimer')}
      </p>
      <span className="sr-only" aria-live="polite">
        {announcement ? t(`ai.workspace.announce.${announcement}` as LocaleKey) : null}
      </span>
    </div>
  );
}

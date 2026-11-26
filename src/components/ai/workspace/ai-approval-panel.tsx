import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ShieldAlertIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/empty-state';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import { approvalIdentityKey, type ApprovalDecision } from '@/lib/ai/approval-decision';
import type { AiToolNode } from '@/lib/ai/conversation-node';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { cn } from '@/lib/utils';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionEffect } from '@/types/agent-session';
import { AiErrorNotice } from './ai-error-notice';
import { AiToolCopyButton, AiToolExpandedContent, classifyAiTool, toolDiffPreview } from './ai-tool-presentation';
import { AiContentTitle } from './ai-content-title';
import { AiNativeCodeFade } from './ai-native-code-fade';
import { AiSubmissionButtonLabel, submissionFeedbackMs } from './ai-submission-button-label';
import { AI_CONTENT_CODE_CLASS } from './ai-style-classes';

const MAX_REJECT_NOTE_BYTES = 2048;

export interface AiApprovalPanelProps {
  readonly approval: AiPendingApproval;
  readonly decision: ApprovalDecision | null;
  readonly error: string | null;
  readonly argumentsLoading?: boolean;
  readonly argumentsError?: string | null;
  readonly onApprove: () => void;
  readonly onReject: (reason?: string) => void;
}

export function AiApprovalSeat({ approval, decision, error, argumentsLoading, argumentsError,
  onApprove, onReject }: Omit<AiApprovalPanelProps, 'approval' | 'onApprove' | 'onReject'> & {
  readonly approval?: AiPendingApproval | null;
  readonly onApprove?: () => void;
  readonly onReject?: (reason?: string) => void;
}): React.ReactNode {
  const [feedback, setFeedback] = useState<(Pick<AiApprovalPanelProps, 'approval' | 'argumentsLoading' | 'argumentsError'> & {
    readonly key: string;
    readonly decision: ApprovalDecision;
  }) | null>(null);
  const currentKey = approval ? approvalIdentityKey(approval) : null;
  const failed = feedback !== null && feedback.key === currentKey && error !== null && decision === null;
  const retained = failed ? null : feedback;

  useEffect(() => {
    if (!feedback) return;
    if (failed) {
      setFeedback(null);
      return;
    }
    const timeout = setTimeout(() => setFeedback(null), submissionFeedbackMs);
    return () => clearTimeout(timeout);
  }, [feedback, failed]);

  const displayed = retained?.approval ?? approval;
  if (!displayed) return null;

  const submit = (choice: ApprovalDecision, run?: () => void) => {
    if (!approval || !currentKey || !run || retained || decision) return;
    // Keep this card mounted if a committed event clears the approval immediately.
    setFeedback({ key: currentKey, approval, decision: choice, argumentsLoading, argumentsError });
    run();
  };
  const displayedKey = retained?.key ?? currentKey;

  return <div
    data-slot="ai-approval-overlay"
    className="min-h-0 min-w-0 [&>[data-slot=ai-approval-panel]]:max-h-[min(600px,45dvh)]"
  >
    <AiApprovalPanel key={displayedKey} approval={displayed}
      decision={retained?.decision ?? decision}
      error={displayedKey === currentKey ? error : null}
      argumentsLoading={retained ? retained.argumentsLoading : argumentsLoading}
      argumentsError={retained ? retained.argumentsError : argumentsError}
      onApprove={() => submit('approve', onApprove)}
      onReject={(reason) => submit('reject', onReject ? () => onReject(reason) : undefined)}
    />
  </div>;
}

function targetLabel(approval: AiPendingApproval): string {
  const target = approval.target;
  if (!target) return approval.callId;
  return target.label ?? target.host ?? target.targetId;
}

function argumentString(approval: AiPendingApproval, key: string): string | null {
  if (!approval.arguments || typeof approval.arguments !== 'object' || Array.isArray(approval.arguments)) return null;
  const value = (approval.arguments as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function trimmedArgumentString(approval: AiPendingApproval, key: string): string | null {
  const value = argumentString(approval, key)?.trim();
  return value ? value : null;
}

function isMachinePrompt(value: string): boolean {
  return value.length > 240
    || value.includes('\n')
    || /Session task|Native effect:|Sensitive paths:|Network destinations:|TTL:/i.test(value);
}

function intentLabel(approval: AiPendingApproval): string | null {
  const explanation = trimmedArgumentString(approval, 'explanation');
  if (explanation) return explanation;
  const prompt = approval.prompt?.trim();
  return prompt && !isMachinePrompt(prompt) ? prompt : null;
}

const APPROVAL_ACTION_KEYS: Readonly<Record<string, LocaleKey>> = {
  list_directory: 'ai.workspace.approval.action.listDirectory',
  read_file: 'ai.workspace.approval.action.readFile',
  write_file: 'ai.workspace.approval.action.writeFile',
  edit_file: 'ai.workspace.approval.action.editFile',
  inspect_vim_buffer: 'ai.workspace.approval.action.inspectVimBuffer',
  insert_vim_text: 'ai.workspace.approval.action.insertVimText',
  save_vim_buffer: 'ai.workspace.approval.action.saveVimBuffer',
  close_vim_editor: 'ai.workspace.approval.action.closeVimEditor',
  search_text: 'ai.workspace.approval.action.searchText',
  trash_file: 'ai.workspace.approval.action.trashFile',
};

const APPROVAL_RISK_KEYS = {
  none: {
    label: 'ai.workspace.approval.risk.none',
    description: 'ai.workspace.approval.risk.none.description',
  },
  readOnly: {
    label: 'ai.workspace.approval.risk.readOnly',
    description: 'ai.workspace.approval.risk.readOnly.description',
  },
  sensitiveRead: {
    label: 'ai.workspace.approval.risk.sensitiveRead',
    description: 'ai.workspace.approval.risk.sensitiveRead.description',
  },
  stateChange: {
    label: 'ai.workspace.approval.risk.stateChange',
    description: 'ai.workspace.approval.risk.stateChange.description',
  },
  destructive: {
    label: 'ai.workspace.approval.risk.destructive',
    description: 'ai.workspace.approval.risk.destructive.description',
  },
  externalSideEffect: {
    label: 'ai.workspace.approval.risk.externalSideEffect',
    description: 'ai.workspace.approval.risk.externalSideEffect.description',
  },
  unknown: {
    label: 'ai.workspace.approval.risk.unknown',
    description: 'ai.workspace.approval.risk.unknown.description',
  },
} as const satisfies Record<AgentSessionEffect, { readonly label: LocaleKey; readonly description: LocaleKey }>;

function approvalTitleKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.title';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandTitle.remote'
    : 'ai.workspace.approval.commandTitle.local';
}

function approvalDescriptionKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.description';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandDescription.remote'
    : 'ai.workspace.approval.commandDescription.local';
}

function ApprovalCommandPreview({ text, label, copyLabel }: {
  readonly text: string;
  readonly label: string;
  readonly copyLabel: string;
}) {
  const viewportRef = useRef<HTMLPreElement>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground" data-slot="ai-approval-command-label">{label}</p>
      <div className="ai-approval-command ai-approval-command-card ai-tool-content-region relative min-w-0 overflow-hidden" data-ai-copy-region>
        <pre ref={viewportRef} className={cn(AI_CONTENT_CODE_CLASS, 'max-h-65 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]')} tabIndex={0} aria-label={label}><code>{text}</code></pre>
        <AiToolCopyButton text={text} label={copyLabel} />
        <AiNativeCodeFade viewportRef={viewportRef} text={text} />
      </div>
    </div>
  );
}

export function AiApprovalPanel({
  approval,
  decision,
  error,
  argumentsLoading = false,
  argumentsError = null,
  onApprove,
  onReject,
}: AiApprovalPanelProps): React.ReactNode {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rejectNoteRef = useRef<HTMLTextAreaElement>(null);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [rejectNoteOpen, setRejectNoteOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const pending = decision !== null;
  const rejectNoteTooLong = new TextEncoder().encode(rejectNote.trim()).length > MAX_REJECT_NOTE_BYTES;
  const command = argumentString(approval, 'command');
  const vimInsertion = approval.toolName === 'insert_vim_text';
  const inputKind = argumentString(approval, 'inputKind');
  const terminalInputText = approval.toolName === 'write_terminal_input' || vimInsertion
    ? argumentString(approval, 'text')
    : null;
  const terminalInput = terminalInputText !== null
    ? JSON.stringify(terminalInputText)
    : approval.toolName === 'write_terminal_input'
      ? argumentString(approval, 'key')
        ?? (inputKind === 'interrupt' ? inputKind : null)
      : null;
  const terminalMatchText = approval.toolName === 'wait_terminal'
    ? argumentString(approval, 'text')
    : null;
  const terminalMatch = terminalMatchText === null ? null : JSON.stringify(terminalMatchText);
  const argumentRecord = approval.arguments && typeof approval.arguments === 'object'
    && !Array.isArray(approval.arguments)
    ? approval.arguments as Record<string, unknown>
    : null;
  const elevated = command !== null && argumentRecord?.elevated === true;
  const commandImpactKey = elevated ? 'ai.workspace.approval.sudoImpact'
    : approval.commandSandbox === 'local' ? 'ai.workspace.approval.localSandboxImpact'
      : approval.commandSandbox === 'remote' ? 'ai.workspace.approval.remoteSandboxImpact'
        : 'ai.workspace.approval.unsandboxedImpact';
  const target = approval.target;
  const runner = argumentRecord?.sudoOperation && typeof argumentRecord.sudoOperation === 'object'
    ? argumentRecord.sudoOperation as Record<string, unknown> : null;
  const username = typeof runner?.runnerUsername === 'string' ? runner.runnerUsername : target?.username;
  const port = typeof runner?.runnerPort === 'number' ? runner.runnerPort : target?.port;
  const targetDescription = elevated && username && target?.host
    ? `${username}@${target.host.includes(':') ? `[${target.host}]` : target.host}:${port ?? 22}`
    : targetLabel(approval);
  const approveLabelKey = approval.toolName === 'trash_file'
    ? 'ai.workspace.approval.action.trashFile'
    : elevated ? 'ai.workspace.approval.approveAndRun' : 'ai.workspace.approval.approveOnce';
  const approveLabel = t(approveLabelKey);
  const volatileArgumentsRequired = argumentRecord?.contentPersisted === false && (
    approval.toolName === 'write_terminal_input'
      ? inputKind === 'text' || inputKind === 'paste'
      : (approval.toolName === 'wait_terminal' || vimInsertion) && argumentRecord.textProvided === true
  );
  const volatileArgumentsMissing = volatileArgumentsRequired
    && (approval.toolName === 'write_terminal_input' || vimInsertion
      ? terminalInputText === null
      : terminalMatchText === null);
  const volatileArgumentsError = argumentsError
    ?? (volatileArgumentsMissing && !argumentsLoading
      ? t('ai.workspace.approval.previewUnavailable')
      : null);
  const exactValue = elevated ? `sudo -- ${command}` : command ?? terminalInput ?? terminalMatch;
  const action = t(APPROVAL_ACTION_KEYS[approval.toolName] ?? 'ai.workspace.approval.action.tool', {
    tool: approval.toolName,
  });
  const actionPath = argumentString(approval, 'path');
  const searchQuery = approval.toolName === 'search_text' ? argumentString(approval, 'query') : null;
  const exactValueLabel = command
    ? 'ai.workspace.approval.command'
    : vimInsertion ? 'ai.workspace.approval.vimText'
    : terminalMatch
      ? 'ai.workspace.approval.terminalMatch'
      : 'ai.workspace.approval.terminalInput';
  const intent = intentLabel(approval);
  const titleKey = approvalTitleKey(approval, command);
  const remoteAllowOnce = titleKey === 'ai.workspace.approval.commandTitle.remote'
    && approveLabelKey === 'ai.workspace.approval.approveOnce';
  const descriptionKey = approvalDescriptionKey(approval, command);
  const riskKeys = APPROVAL_RISK_KEYS[approval.risk];
  const recoverableDeletion = approval.toolName === 'trash_file';
  const destructive = approval.risk === 'destructive' && !recoverableDeletion;
  const diffPreview = useMemo(() => {
    if (volatileArgumentsMissing) return null;
    const variant = classifyAiTool(approval.toolName);
    if (variant !== 'edit' && variant !== 'write') return null;
    const syntheticNode: AiToolNode = {
      kind: 'tool',
      key: `approval-preview:${approval.approvalId}`,
      sourceKind: 'agent',
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      stepId: approval.stepId,
      firstSeq: 0,
      lastSeq: 0,
      timestamp: '',
      callId: approval.callId,
      name: approval.toolName,
      nativeName: approval.toolName,
      title: approval.toolName,
      summary: '',
      state: 'approval',
      effect: approval.effect,
      durationMs: null,
      detailRef: {
        kind: 'agentTool',
        sessionId: approval.sessionId,
        callId: approval.callId,
        turnId: approval.turnId,
        stepId: approval.stepId,
      },
      evidenceRefs: approval.evidenceRefs,
      input: approval.arguments,
      output: null,
      error: null,
      target: approval.target,
      idempotency: null,
      approval: null,
    };
    const model = toolDiffPreview(syntheticNode);
    return model ? { node: syntheticNode, model } : null;
  }, [approval, volatileArgumentsMissing]);

  const openRejectNote = (): void => {
    setRejectNoteOpen(true);
    requestAnimationFrame(() => {
      rejectNoteRef.current?.scrollIntoView?.({ block: 'nearest' });
      rejectNoteRef.current?.focus({ preventScroll: true });
    });
  };
  const submitRejectWithNote = (): void => {
    if (pending || rejectNoteTooLong) return;
    const trimmed = rejectNote.trim();
    onReject(trimmed || undefined);
  };

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [approval.approvalId]);

  const approvalTitleId = useId();
  const approvalDescriptionId = useId();
  return (
    <Card
      className="ai-approval-panel grid min-h-0 max-h-[min(600px,72dvh)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 py-0"
      size="sm"
      role="group"
      aria-labelledby={approvalTitleId}
      aria-describedby={approvalDescriptionId}
      data-slot="ai-approval-panel"
      data-approval-id={approval.approvalId}
    >
      <CardHeader className="ai-approval-panel-header shrink-0 gap-2 px-4 py-3 has-data-[slot=card-action]:grid-cols-1 @min-[480px]/ai-workspace:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-start gap-1">
          <span className="flex h-7 w-6 shrink-0 items-center justify-center text-app-warning" aria-hidden="true">
            <ShieldAlertIcon />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle className="ai-approval-panel-title">
              <h3 id={approvalTitleId} ref={headingRef} tabIndex={-1} className="outline-none">
                <AiContentTitle>{t(titleKey, { tool: approval.toolName })}</AiContentTitle>
              </h3>
            </CardTitle>
            <CardDescription id={approvalDescriptionId} className="break-words">
              <AiContentTitle>{t(descriptionKey, { target: targetDescription })}</AiContentTitle>
            </CardDescription>
          </div>
        </div>
        <CardAction className="col-start-1 row-span-1 row-start-auto justify-self-start pl-7 @min-[480px]/ai-workspace:col-start-2 @min-[480px]/ai-workspace:row-start-1 @min-[480px]/ai-workspace:pl-0">
          <Badge variant={destructive ? 'destructive' : 'outline'}>{t(recoverableDeletion ? 'ai.workspace.approval.trashRecoveryLabel' : riskKeys.label)}</Badge>
        </CardAction>
      </CardHeader>

      <ScrollArea className="flex max-h-65 min-h-0 min-w-0 flex-col" viewportRender={<div className="h-auto min-h-0 flex-1" />}>
        <ScrollAreaContent style={{ minWidth: 0 }}>
          <CardContent className="flex min-w-0 flex-col gap-3 px-4 pb-2">
            {(!exactValue || vimInsertion) && (
              <div className="flex min-w-0 flex-col gap-1" data-slot="ai-approval-action">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.action')}</p>
                <p className="break-words text-sm">{action}</p>
                {actionPath && (
                  <div className="ai-approval-command ai-tool-content-region relative min-w-0 overflow-hidden" data-ai-copy-region>
                    <pre className={cn(AI_CONTENT_CODE_CLASS, 'max-h-65 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]')} tabIndex={0}><code>{actionPath}</code></pre>
                    <AiToolCopyButton text={actionPath} label={t('ai.workspace.tool.copyInput')} />
                  </div>
                )}
                {searchQuery && <p className="whitespace-pre-wrap break-words text-sm">{t('ai.workspace.approval.query', { query: searchQuery })}</p>}
              </div>
            )}

            {!command && approval.target && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.target')}</p>
                <p className="break-words text-sm">{targetLabel(approval)}</p>
              </div>
            )}

            {exactValue && (command ? (
              <ApprovalCommandPreview text={exactValue} label={t(exactValueLabel)} copyLabel={t('ai.workspace.tool.copyCommand')} />
            ) : (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{t(exactValueLabel)}</p>
                <div className="ai-approval-command ai-tool-content-region relative min-w-0 overflow-hidden" data-ai-copy-region>
                  <pre className={cn(AI_CONTENT_CODE_CLASS, 'max-h-65 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]')} tabIndex={0}><code>{exactValue}</code></pre>
                  <AiToolCopyButton text={exactValue} label={t('ai.workspace.tool.copyInput')} />
                </div>
              </div>
            ))}

            {volatileArgumentsMissing && argumentsLoading && !volatileArgumentsError && (
              <Alert variant="info" size="sm" role="status">
                <Spinner aria-hidden="true" data-icon="inline-start" />
                <AlertDescription>{t('ai.workspace.approval.previewLoading')}</AlertDescription>
              </Alert>
            )}

            {volatileArgumentsError && (
              <AiErrorNotice title={t('ai.workspace.approval.previewUnavailableTitle')}>
                {aiErrorMessage(volatileArgumentsError, t)}
              </AiErrorNotice>
            )}

            {diffPreview && (
              <div className="flex min-w-0 flex-col gap-1" data-slot="ai-approval-diff-preview">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.changesPreview')}</p>
                <AiToolExpandedContent
                  node={diffPreview.node}
                  compact
                  showCopyActions={false}
                  showInput={false}
                  hideHeader
                  foldContext
                  scrollable
                  diffModel={diffPreview.model}
                />
              </div>
            )}

            {intent && (
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.intent')}</p>
                <p className="break-words text-sm">{intent}</p>
              </div>
            )}

            <Alert
              variant={destructive ? 'destructiveSubtle' : 'warning'}
              size="sm"
              role="note"
            >
              <ShieldAlertIcon aria-hidden="true" />
              <AlertDescription className="flex flex-wrap items-center gap-x-1">
                <span className="font-medium">{t('ai.workspace.approval.impact')}</span>
                <span>{t(approval.toolName === 'trash_file' ? 'ai.workspace.approval.trashImpact' : riskKeys.description)}</span>
                {command && <span>{t(commandImpactKey)}</span>}
              </AlertDescription>
            </Alert>

            {rejectNoteOpen && (
              <Field className="gap-1.5" data-invalid={rejectNoteTooLong || undefined} data-slot="ai-approval-reject-note">
                <FieldLabel htmlFor={`${approval.approvalId}-reject-note`} className="text-xs text-muted-foreground">
                  {t('ai.workspace.approval.rejectNoteLabel')}
                </FieldLabel>
                <InputGroup className="ai-question-custom-group min-h-[34px] items-start">
                  <InputGroupTextarea
                    ref={rejectNoteRef}
                    id={`${approval.approvalId}-reject-note`}
                    className="ai-question-custom-input min-h-[34px] max-h-24 resize-none px-2.5 py-[7px] text-xs leading-relaxed"
                    rows={2}
                    disabled={pending}
                    value={rejectNote}
                    aria-invalid={rejectNoteTooLong || undefined}
                    maxLength={MAX_REJECT_NOTE_BYTES}
                    placeholder={t('ai.workspace.approval.rejectNotePlaceholder')}
                    onChange={(event) => setRejectNote(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        submitRejectWithNote();
                      }
                    }}
                  />
                </InputGroup>
                {rejectNoteTooLong && (
                  <FieldError>{t('ai.workspace.approval.rejectNoteTooLong')}</FieldError>
                )}
              </Field>
            )}

            {!volatileArgumentsMissing && approval.arguments !== undefined && approval.arguments !== null && (
              <Collapsible open={parametersOpen} onOpenChange={setParametersOpen}>
                <CollapsibleTrigger
                  render={(
                    <Button variant="ghost" size="xs" className="self-start" aria-expanded={parametersOpen}>
                      {t('ai.workspace.approval.fullParameters')}
                      <ChevronDownIcon className={cn('size-3 transition-transform', parametersOpen && 'rotate-180')} aria-hidden="true" data-icon="inline-end" />
                    </Button>
                  )}
                />
                <CollapsibleContent>
                  <div className="ai-approval-command ai-tool-content-region relative mt-1.5 min-w-0 overflow-hidden" data-ai-copy-region data-slot="ai-approval-full-parameters">
                    <pre className={cn(AI_CONTENT_CODE_CLASS, 'max-h-56 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]')} tabIndex={0}>
                      <code>{typeof approval.arguments === 'string' ? approval.arguments : JSON.stringify(approval.arguments, null, 2)}</code>
                    </pre>
                    <AiToolCopyButton
                      text={typeof approval.arguments === 'string' ? approval.arguments : JSON.stringify(approval.arguments, null, 2)}
                      label={t('ai.workspace.tool.copyInput')}
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {error && (
              <AiErrorNotice title={t('ai.workspace.recovery.title')}>
                {aiErrorMessage(error, t)}
              </AiErrorNotice>
            )}
          </CardContent>
        </ScrollAreaContent>
      </ScrollArea>

      <CardFooter className="ai-approval-panel-footer shrink-0 flex-wrap justify-end gap-2 px-4 pt-2 pb-3">
        {rejectNoteOpen ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setRejectNoteOpen(false)}
            >
              {t('ai.workspace.approval.rejectBack')}
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={pending || rejectNoteTooLong}
              aria-busy={decision === 'reject' || undefined}
              onClick={submitRejectWithNote}
              aria-label={t('ai.workspace.approval.rejectSubmit')}
            >
              <AiSubmissionButtonLabel label={t('ai.workspace.approval.rejectSubmit')} busy={decision === 'reject'} />
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={pending} aria-busy={decision === 'reject' || undefined} onClick={() => onReject()} aria-label={t('ai.workspace.approval.reject')}>
              <AiSubmissionButtonLabel label={t('ai.workspace.approval.reject')} busy={decision === 'reject'} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={openRejectNote}
              aria-label={t('ai.workspace.approval.rejectWithNote')}
            >
              {t('ai.workspace.approval.rejectWithNote')}
            </Button>
            <Button
              size="sm"
              variant="warning"
              data-remote-allow-once={remoteAllowOnce || undefined}
              disabled={pending || volatileArgumentsMissing}
              aria-busy={decision === 'approve' || argumentsLoading || undefined}
              onClick={onApprove}
              aria-label={approveLabel}
            >
              <AiSubmissionButtonLabel label={approveLabel} busy={decision === 'approve'} />
            </Button>
          </>
        )}
      </CardFooter>
      <span className="sr-only" aria-live="polite">
        {pending ? t('ai.workspace.approval.pending') : error}
      </span>
    </Card>
  );
}

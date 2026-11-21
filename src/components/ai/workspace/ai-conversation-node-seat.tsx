import React, { use, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileInputIcon,
  FileOutputIcon,
  NotebookTextIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SquareIcon,
} from 'lucide-react';

import { AssistantMessageContent, StreamingMarkdownContent } from '@/components/ai/assistant-message-content';
import { StreamingText, StreamingTextContext } from '@/components/ai/streaming-text';
import { Bubble, Message, MessageActions } from '@/components/ai/chat-primitives';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Marker as MarkerPrimitive, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import {
  MessageScrollerProvider,
  MessageScroller as ContentScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
} from '@/components/ui/message-scroller';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNode, AiConversationNodeOf, AiTurnProcessStatus } from '@/lib/ai/conversation-node';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { createStreamingMarkdownSplitter } from '@/lib/streaming-markdown';
import { taskBudgetArtifactTitleKey } from '@/lib/ai/task-token-budget';
import { isRuntimeArtifact } from '@/lib/ai/conversation-artifact';
import { requestErrorMessageKey, requestRetryMessageKey } from '@/lib/ai/request-error';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { AiToolCopyButton, AiToolRow, AiToolTextSection } from './ai-tool-presentation';
import { AiTurnFooter } from './ai-turn-footer';
import { AiProcessingStatus } from './ai-processing-status';
import { AiCompactionStatus } from './ai-compaction-status';
import { AiQuestionHistory } from './ai-question-panel';
import { AiFailureRecoveryAction } from './ai-failure-recovery';
import { AiNoticeAction } from './ai-notice-action';
import { AiFailedDraftRecovery, AiFailedDraftRecoveryContext, failedDraftForMessage } from './ai-failed-draft-recovery';
import { isReadingProcess, processDisclosureKey, processFoldsOnCompletion, setProcessPanelHeightTiming, storeProcessDisclosure, useProcessDisclosure } from './ai-process-disclosure';
import {
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_ROW_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
} from './ai-style-classes';

type AiConversationNodeRendererProps<Kind extends AiConversationNode['kind']> = {
  readonly node: AiConversationNodeOf<Kind>;
  readonly inTurnProcess?: boolean;
  readonly deferMessageActions?: boolean;
  readonly processControlOnly?: boolean;
  readonly hasResponse?: boolean;
  readonly processPanelIds?: string;
  readonly renderers?: AiConversationNodeRendererMap;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
};

export type AiConversationNodeRendererMap = {
  readonly [Kind in Exclude<AiConversationNode['kind'], 'runtimeArtifacts'>]: React.ComponentType<AiConversationNodeRendererProps<Kind>>;
};

function assistantText(node: AiConversationNodeOf<'assistantMessage'>): string {
  return node.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

function SemanticNoteDisclosure({
  body,
  bodyClassName,
  icon,
  label,
  summary,
  content,
}: {
  readonly body: string;
  readonly bodyClassName?: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly summary?: string;
  readonly content?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="ai-semantic-note min-w-0 max-w-full" data-expanded={open || undefined}>
        <MarkerPrimitive className="ai-semantic-note-marker min-w-0">
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="plain"
                size="sm"
                className={`${AI_DISCLOSURE_ROW_CLASS} flex-1`}
                aria-label={label}
                aria-expanded={open}
              />
            }
          >
            <MarkerIcon className={AI_DISCLOSURE_LEADING_CLASS}>
              {icon}
              <ChevronDownIcon className="ai-disclosure-chevron" />
            </MarkerIcon>
            <MarkerContent className="ai-semantic-note-heading flex min-w-0 flex-1 items-center">
              <span className={AI_DISCLOSURE_TITLE_CLASS}>{label}</span>
              {summary && (
                <>
                  <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
                  <span className={AI_DISCLOSURE_SUMMARY_CLASS}>{summary}</span>
                </>
              )}
            </MarkerContent>
          </CollapsibleTrigger>
        </MarkerPrimitive>
        <CollapsibleContent>
          <Separator className="ai-semantic-note-separator" />
          {content ?? (
            <div className={cn(
              'ai-semantic-note-body relative mt-1 ml-[22px] box-border max-h-65 w-[calc(100%-22px)] overflow-auto pt-2.5 pr-10 pb-3 pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
              bodyClassName,
            )}>
              {body}
              <AiToolCopyButton text={body} className="ai-content-copy absolute top-1 right-1" />
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function SystemPromptRow({ node }: { readonly node: AiConversationNodeOf<'systemPrompt'> }) {
  const { t } = useI18n();
  return <SemanticNoteDisclosure body={node.content} icon={<NotebookTextIcon />} label={t('ai.workspace.systemPrompt')} />;
}

function contextLabelKey(kind: AiConversationNodeOf<'contextInjection'>['provenance']['kind']): LocaleKey {
  switch (kind) {
    case 'runtime':
      return 'ai.workspace.context.runtime';
    case 'plugin':
      return 'ai.workspace.context.plugin';
    case 'skill-catalog':
      return 'ai.workspace.context.skillCatalog';
    case 'agent-instructions':
      return 'ai.workspace.context.agentInstructions';
    case 'skill-invocation':
      return 'ai.workspace.context.skillInvocation';
    case 'session-reference':
      return 'ai.workspace.context.sessionReference';
    case 'form':
      return 'ai.workspace.context.form';
    case 'user':
      return 'ai.workspace.context.user';
  }
}

export function isUserVisibleContextInjection(node: AiConversationNodeOf<'contextInjection'>): boolean {
  return node.provenance.kind !== 'runtime' && node.provenance.kind !== 'agent-instructions' && node.provenance.kind !== 'skill-catalog';
}

function ContextInjectionRow({ node }: { readonly node: AiConversationNodeOf<'contextInjection'> }) {
  const { t } = useI18n();
  if (!isUserVisibleContextInjection(node)) return null;
  const skillBody = node.loadedSkill
    ? `${node.loadedSkill.instructions}\n\n${t('ai.workspace.skills.source')}\n${JSON.stringify(node.loadedSkill.provenance, null, 2)}\nrenderedHash: ${node.loadedSkill.renderedHash}`
    : node.content;
  const body = node.loadedSkill ? `${t('ai.workspace.skills.instructions')}\n${skillBody}` : node.content;
  const content = node.provenance.kind === 'skill-invocation' ? (
    <div className="ai-io-card my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col gap-3">
      <AiToolTextSection title={t(node.loadedSkill ? 'ai.workspace.skills.instructions' : 'ai.workspace.skills.loadFailed')} text={skillBody} copyText={body} />
    </div>
  ) : node.provenance.kind === 'session-reference' ? (
    <div className="ai-io-card my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col gap-3">
      <AiToolTextSection title={t('ai.workspace.context.sessionReference')} text={node.content} copyText={node.content} showHeader={false} />
    </div>
  ) : undefined;
  return (
    <SemanticNoteDisclosure
      body={body}
      content={content}
      icon={<FileInputIcon />}
      label={t(contextLabelKey(node.provenance.kind))}
      summary={node.provenance.label}
    />
  );
}

import { AiCommittedImages } from './ai-image-attachments';
import { AiDocumentAttachments } from './ai-document-attachments';
import { AiDraftAttachmentRail, UnifiedAttachmentContext } from './ai-image-draft-rail';
import { decodeDocumentMessage } from '@/lib/ai/document-message';
import { AiUserMessageText } from './ai-user-message-text';

function UserMessageNodeView({ node }: { readonly node: AiConversationNodeOf<'userMessage'> }) {
  const { t } = useI18n();
  // Only failed sends subscribe to recovery; typing must not rerender committed history.
  const recovery = node.delivery === 'failed' || node.delivery === 'unconfirmed'
    ? use(AiFailedDraftRecoveryContext) : undefined;
  const failed = failedDraftForMessage(node, recovery?.composerState?.failedDrafts ?? []);
  // Keep the same animation across receipt updates; committed history never
  // starts a send animation when it is mounted or reopened.
  const reveal = useRef(node.delivery === 'pending');
  const message = decodeDocumentMessage(node.content);
  const files = message.documents.filter(document => document.chatTitle === undefined);
  const references = message.documents.filter(document => document.chatTitle !== undefined);
  const pendingIndicator = failed ? null : node.delivery === 'confirming' || node.delivery === 'unconfirmed' ? (
    <Badge variant="secondary">{t(node.delivery === 'unconfirmed' ? 'ai.workspace.messageUnconfirmed' : 'ai.workspace.messageConfirming')}</Badge>
  ) : node.delivery === 'pending' ? (
    <Spinner className="ai-user-sending" aria-label={t('ai.workspace.messagePending')} />
  ) : null;
  return (
    <Message role="user">
      {node.inputKind === 'steer' && (
        <Badge variant="secondary" className="self-end">
          {t('ai.workspace.messageSteering')}
        </Badge>
      )}
      {Boolean(node.images?.length || message.documents.length) && (
        <div className="ai-user-attachments relative flex w-max min-w-0 max-w-full flex-col items-end gap-1.5">
          {!message.text && pendingIndicator}
          <UnifiedAttachmentContext value={true}>
            {Boolean(node.images?.length || files.length) && <AiDraftAttachmentRail unified count={(node.images?.length ?? 0) + files.length}>
              <AiCommittedImages sessionId={node.sessionId} images={node.images} />
              <AiDocumentAttachments composer documents={files} />
            </AiDraftAttachmentRail>}
            <AiDocumentAttachments composer documents={references} />
          </UnifiedAttachmentContext>
        </div>
      )}
      {(message.text || node.delivery === 'failed' || failed?.hasImages) && (
        <Bubble role="user" className={reveal.current ? 'ai-user-bubble-enter' : undefined}>
          {pendingIndicator}
          <AiUserMessageText key={message.text} text={message.text || (failed?.hasImages ? t('ai.workspace.images.attachments') : '')} />
          {node.delivery === 'failed' && !failed && (
            <span className="ai-user-delivery mt-0.5 block" data-state={node.delivery}>
              {t('ai.workspace.messageNotSent')}
            </span>
          )}
        </Bubble>
      )}
      {failed && <AiFailedDraftRecovery {...recovery} failed={failed} />}
      <MessageActions text={message.text} timestamp={node.timestamp || undefined} align="end" />
    </Message>
  );
}

function AssistantMessageNodeView({ node, inTurnProcess = false, deferMessageActions = false }: AiConversationNodeRendererProps<'assistantMessage'>) {
  const { t } = useI18n();
  const text = assistantText(node);
  if (!text) return null;
  return (
    <Message role="assistant">
      <Bubble role="assistant">
        <AssistantMessageContent blocks={node.blocks} streaming={node.state === 'streaming'} />
        {(node.state === 'interrupted' || node.state === 'failed' || node.state === 'cancelled') && (
          <span className="ai-assistant-stopped self-start px-1.5" data-state={node.state}>
            {node.partialReason === 'outputLimit'
              ? t('ai.workspace.messageOutputLimit')
              : node.state === 'failed'
                ? t('ai.message.failed')
                : node.state === 'cancelled'
                  ? t('ai.message.cancelled')
                  : t('ai.workspace.messageInterrupted')}
          </span>
        )}
      </Bubble>
      {!inTurnProcess && !deferMessageActions && !node.hasTurnTail && node.state === 'completed' && (
        <MessageActions text={text} timestamp={node.timestamp} align="start" className="ai-assistant-actions -ml-1.5 mt-2.5" />
      )}
    </Message>
  );
}

function ReasoningContent({ children, streaming }: { readonly children: string; readonly streaming: boolean }) {
  const { t } = useI18n();
  const [defaultScrollPosition] = useState<'start' | 'end'>(streaming ? 'end' : 'start');
  const splitMarkdown = useMemo(() => createStreamingMarkdownSplitter(), []);
  const chunks = useMemo(() => splitMarkdown(children), [children, splitMarkdown]);
  const previousSource = useRef('');
  const previous = children.startsWith(previousSource.current) ? previousSource.current : '';
  useLayoutEffect(() => {
    previousSource.current = children;
  }, [children]);
  let offset = 0;
  return (
    <MessageScrollerProvider autoScroll={streaming} defaultScrollPosition={defaultScrollPosition}>
      <ContentScroller className="ai-reasoning-scroll h-auto max-h-65 w-full">
        <MessageScrollerViewport className="ai-reasoning-viewport h-auto" aria-label={t('ai.workspace.reasoning')}>
          <MessageScrollerContent className="ai-reasoning-body min-h-0 min-w-0 gap-0 py-1 pl-[22px] whitespace-normal [overflow-wrap:anywhere]">
            {chunks.map((chunk, index) => {
              // A completed look-ahead line can move already visible text into a new
              // chunk. Seed its reveal baseline instead of replaying its entrance.
              const initialSource = previous.slice(offset, offset + chunk.length);
              offset += chunk.length;
              return (
                <StreamingMarkdownContent
                  key={index}
                  initialSource={initialSource}
                  copiedLabel={t('common.copied')}
                  copyLabel={t('common.copy')}
                  showCodeBlockActions={false}
                  streaming={streaming && index === chunks.length - 1}
                >
                  {chunk}
                </StreamingMarkdownContent>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </ContentScroller>
    </MessageScrollerProvider>
  );
}

function ReasoningNodeView({ node }: { readonly node: AiConversationNodeOf<'reasoning'> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isStreaming = node.state === 'streaming';
  const lines = node.content.trim().split('\n');
  const summary = (isStreaming ? lines[lines.length - 1] : lines[0]) || node.summary.trim();
  const title = isStreaming ? t('ai.thinking.inProgress') : node.state === 'interrupted' ? t('ai.thinking.interrupted') : t('ai.workspace.reasoning');

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-reasoning-row flex min-w-0 flex-col"
        data-state={isStreaming ? 'running' : node.state === 'interrupted' ? 'interrupted' : 'ok'}
        data-expanded={open || undefined}
        role={isStreaming ? 'status' : undefined}
      >
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="plain"
              size="sm"
              className={AI_DISCLOSURE_ROW_CLASS}
              aria-label={summary ? `${title} ${summary}` : title}
              aria-expanded={open}
            />
          }
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            <BrainIcon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={cn(AI_DISCLOSURE_TITLE_CLASS, isStreaming && 'shimmer')}>{title}</span>
          {summary && (
            <>
              <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
              <span className={AI_DISCLOSURE_SUMMARY_CLASS}>
                <StreamingTextContext.Provider value={isStreaming}>
                  <StreamingText key={isStreaming ? lines.length - 1 : 0}>{summary}</StreamingText>
                </StreamingTextContext.Provider>
              </span>
            </>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ReasoningContent streaming={isStreaming}>{node.content || node.summary}</ReasoningContent>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function AskReasoningNodeView({ node }: { readonly node: AiConversationNodeOf<'reasoning'> }) {
  const { t } = useI18n();
  const [manualOpen, setManualOpen] = useState<boolean>();
  const isStreaming = node.state === 'streaming';
  const open = manualOpen ?? isStreaming;
  const title = isStreaming ? t('ai.thinking.inProgress') : node.state === 'interrupted' ? t('ai.thinking.interrupted') : t('ai.thinking');

  return (
    <Collapsible open={open} onOpenChange={setManualOpen}>
      <div
        className="ai-reasoning-row ai-ask-reasoning-row flex min-w-0 flex-col"
        data-state={isStreaming ? 'running' : node.state === 'interrupted' ? 'interrupted' : 'ok'}
        data-expanded={open || undefined}
        role={isStreaming ? 'status' : undefined}
      >
        <CollapsibleTrigger
          render={<Button type="button" variant="plain" size="sm" className={AI_DISCLOSURE_ROW_CLASS} aria-label={title} aria-expanded={open} />}
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            <BrainIcon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={cn(AI_DISCLOSURE_TITLE_CLASS, isStreaming && 'shimmer')}>{title}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ReasoningContent streaming={isStreaming}>{node.content || node.summary}</ReasoningContent>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ToolNodeView({
  node,
  onOpenTool,
}: {
  readonly node: AiConversationNodeOf<'tool'>;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
}) {
  return <AiToolRow node={node} onInspect={onOpenTool} />;
}

function ArtifactNodeView({
  node,
  onOpenArtifact,
}: {
  readonly node: AiConversationNodeOf<'artifact'>;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
}) {
  const { t } = useI18n();
  const titleKey = taskBudgetArtifactTitleKey(node.artifactKind);
  const title = titleKey ? t(titleKey) : node.title;
  const internal = isRuntimeArtifact(node);
  return (
    <div className={cn('ai-produced-files min-h-6 min-w-0 items-center', internal
      ? 'flex' : 'grid grid-cols-[max-content_minmax(0,1fr)] gap-2')}>
      {!internal && <span className="ai-produced-files-label inline-flex items-center gap-1 whitespace-nowrap">
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <FileOutputIcon aria-hidden="true" />
        </span>
        {t('ai.workspace.artifact.produced')}
      </span>}
      <button
        type="button"
        className="ai-produced-file m-0 flex min-w-0 max-w-full cursor-default items-center justify-self-start gap-2 overflow-hidden px-2 py-0"
        data-ai-node-action=""
        aria-label={t('ai.workspace.details.openArtifact', { artifact: title })}
        onClick={() => onOpenArtifact?.(node)}
      >
        <span className="min-w-0 truncate">{title}</span>
        {node.sizeBytes !== null && <small className="shrink-0">{node.sizeBytes} B</small>}
      </button>
    </div>
  );
}

function ApprovalMarkerNodeView({ node }: { readonly node: AiConversationNodeOf<'approvalMarker'> }) {
  const { t } = useI18n();
  return (
    <div className="ai-transcript-notice flex h-6 min-w-0 items-center gap-0" data-variant="approval" data-state={node.status}>
      <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
        <ShieldAlertIcon />
      </span>
      <span className={AI_DISCLOSURE_TITLE_CLASS}>{t(`ai.workspace.approval.${node.status}` as LocaleKey)}</span>
      {node.prompt && <span className="ai-transcript-notice-detail ml-1 min-w-0 flex-1 truncate">{node.prompt}</span>}
    </div>
  );
}

function RetryNodeView({ node }: { readonly node: AiConversationNodeOf<'retry'> }) {
  const { t } = useI18n();
  const outputRecovery = node.reason === 'outputLimitContinuation';
  return (
    <div className="ai-transcript-notice flex h-6 min-w-0 items-center gap-0" data-variant="retry" role="status">
      <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
        <RefreshCwIcon />
      </span>
      <span className={AI_DISCLOSURE_TITLE_CLASS}>
        {t(outputRecovery ? 'ai.workspace.outputLimitContinuation' : 'ai.workspace.retry', { attempt: node.attempt })}
      </span>
      <span className="ai-transcript-notice-detail ml-1 min-w-0 flex-1 truncate">
        {outputRecovery ? t('ai.workspace.outputLimitContinuationDetail') : t(requestRetryMessageKey(node.reason))}
      </span>
    </div>
  );
}

function errorNodeMessage(
  node: AiConversationNodeOf<'error'>,
  t: (key: LocaleKey, values?: Record<string, string | number>) => string,
): string {
  if (node.message.startsWith('taskTokenBudgetExceeded:')) return t('ai.workspace.tokenBudget.title');
  if (node.message === 'outputLimit' || node.message.startsWith('outputLimit:') || node.message.includes('code=OUTPUT_LIMIT')) {
    return t('ai.error.outputLimit');
  }
  const translated = aiErrorMessage(node.message, t);
  if (translated !== node.message) return translated;
  return t(requestErrorMessageKey(node.message));
}

function ErrorNodeView({ node }: { readonly node: AiConversationNodeOf<'error'> }) {
  const { t } = useI18n();
  if (node.state === 'cancelled') {
    return (
      <div className="ai-transcript-notice flex h-6 min-w-0 items-center gap-0" data-variant="cancelled" role="status">
        <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
          <SquareIcon />
        </span>
        <span className={AI_DISCLOSURE_TITLE_CLASS}>{t('ai.workspace.stopped')}</span>
      </div>
    );
  }
  return (
    <div className="ai-turn-error grid min-w-0 grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-1 py-0.5" role="alert">
      <CircleAlertIcon aria-hidden="true" />
      <div className="ai-turn-error-copy block min-w-0 translate-y-px [overflow-wrap:anywhere]">
        <span className="ai-turn-error-title mr-1.5">{t('ai.requestFailed')}</span>
        <span>{errorNodeMessage(node, t)}</span>
        <Collapsible className="ai-error-details">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <CollapsibleTrigger render={<AiNoticeAction className="text-muted-foreground" />}>{t('ai.error.details')}</CollapsibleTrigger>
            <AiFailureRecoveryAction turnId={node.turnId} />
          </div>
          <CollapsibleContent>
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {node.message}
              {node.code && <code className="block">{node.code}</code>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}

function turnProcessDisclosureKey(node: AiConversationNodeOf<'turnProcess'>): string {
  // Tool continuations and retries change the request, not the displayed turn.
  // Remounting here restarts the panel's height animation and loses user state.
  return processDisclosureKey(node);
}

function turnProcessLabelKey(status: AiTurnProcessStatus): LocaleKey {
  switch (status) {
    case 'running':
      return 'ai.workspace.turnProcess.running';
    case 'waiting':
      return 'ai.workspace.turnProcess.waiting';
    case 'completed':
      return 'ai.workspace.turnProcess.completed';
    case 'incomplete':
      return 'ai.workspace.turnProcess.incomplete';
    case 'failed':
      return 'ai.workspace.turnProcess.failed';
    case 'cancelled':
      return 'ai.workspace.turnProcess.cancelled';
    case 'partial':
      return 'ai.workspace.turnProcess.partial';
  }
}

function turnProcessSummary(node: AiConversationNodeOf<'turnProcess'>, t: ReturnType<typeof useI18n>['t']): string {
  const counts = new Map<AiConversationNodeOf<'turnProcess'>['children'][number]['kind'], number>();
  for (const child of node.children) {
    const kind = child.kind === 'question' ? 'tool' : child.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [
    ['tool', 'ai.workspace.turnProcess.toolCount'],
    ['retry', 'ai.workspace.turnProcess.retryCount'],
    ['error', 'ai.workspace.turnProcess.errorCount'],
  ] as const;
  return parts
    .flatMap(([kind, key]) => {
      const count = counts.get(kind) ?? 0;
      return count === 0 ? [] : [t(key, { count })];
    })
    .join(t('ai.workspace.turnProcess.separator'));
}

function TurnProcessDisclosure({
  node,
  onOpenArtifact,
  onOpenTool,
  renderers,
  processControlOnly = false,
  processPanelIds,
}: {
  readonly node: AiConversationNodeOf<'turnProcess'>;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
  readonly renderers: AiConversationNodeRendererMap;
  readonly processControlOnly?: boolean;
  readonly processPanelIds?: string;
}) {
  const { t } = useI18n();
  const stateKey = turnProcessDisclosureKey(node);
  const { open, stored } = useProcessDisclosure(node);
  const previousOpen = useRef(open);
  const foldOnCompletion = processFoldsOnCompletion(node);
  const bodyRef = useRef<HTMLDivElement>(null);
  const label = t(turnProcessLabelKey(node.status));
  const summary = turnProcessSummary(node, t);

  const updateOpen = (next: boolean): void => {
    storeProcessDisclosure(stateKey, { open: next, manualOpen: next });
  };

  // Measure reading intent before closing the mounted body. Moving focus or
  // removing selected text on completion would interrupt the reader.
  useLayoutEffect(() => {
    if (stored?.manualOpen === undefined) {
      storeProcessDisclosure(stateKey, { open: !foldOnCompletion || isReadingProcess(node, bodyRef.current) });
    }
  }, [foldOnCompletion, stateKey]);

  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (processPanelIds) setProcessPanelHeightTiming(processPanelIds, open);
  }, [open, processPanelIds]);

  return (
    <Collapsible open={open} onOpenChange={updateOpen}>
      <div
        className="ai-turn-process min-w-0 max-w-full"
        data-expanded={open || undefined}
        data-status={node.status}
        data-answer-generation={node.answerGeneration}
      >
        <CollapsibleTrigger
          {...(processControlOnly ? { 'aria-controls': processPanelIds || undefined } : {})}
          render={
            <Button
              type="button"
              variant="plain"
              size="sm"
              className={cn(AI_DISCLOSURE_ROW_CLASS, 'ai-turn-process-trigger')}
              aria-label={label}
              aria-expanded={open}
            />
          }
        >
          {node.status === 'running' ? (
            <AiProcessingStatus />
          ) : <>
            <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
              <ChevronDownIcon className="ai-disclosure-chevron" />
            </span>
            <span className={AI_DISCLOSURE_TITLE_CLASS}>{label}</span>
          </>}
          {summary && (
            <>
              <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
              <span className={AI_DISCLOSURE_SUMMARY_CLASS}>{summary}</span>
            </>
          )}
        </CollapsibleTrigger>
        <Separator className="ai-turn-process-separator" />
        {!processControlOnly && <CollapsibleContent>
          <div ref={bodyRef} className="ai-turn-process-body flex w-full min-w-0 max-w-full flex-col gap-1 box-border pt-1.5 pr-0 pb-0.5">
            {node.children.map((child) => (
              <div
                key={child.key}
                className="ai-turn-process-child min-w-0 max-w-full empty:hidden"
                data-ai-process-child={child.kind}
                data-ai-process-child-key={child.key}
              >
                <ConversationNodeContent node={child} renderers={renderers} onOpenTool={onOpenTool} onOpenArtifact={onOpenArtifact} inTurnProcess />
              </div>
            ))}
          </div>
        </CollapsibleContent>}
      </div>
    </Collapsible>
  );
}

function TurnProcessRow({
  node,
  onOpenArtifact,
  onOpenTool,
  renderers = aiConversationNodeRenderers,
  processControlOnly,
  hasResponse,
  processPanelIds,
}: AiConversationNodeRendererProps<'turnProcess'>) {
  if (!node.children.some((child) => child.kind !== 'contextInjection' || isUserVisibleContextInjection(child))
    && !(processControlOnly && hasResponse && !node.hasEndBoundary)) return null;
  const key = turnProcessDisclosureKey(node);
  return <TurnProcessDisclosure key={key} node={node} renderers={renderers} onOpenTool={onOpenTool} onOpenArtifact={onOpenArtifact} processControlOnly={processControlOnly} processPanelIds={processPanelIds} />;
}

export const aiConversationNodeRenderers = {
  compaction: AiCompactionStatus,
  systemPrompt: SystemPromptRow,
  contextInjection: ContextInjectionRow,
  userMessage: UserMessageNodeView,
  assistantMessage: AssistantMessageNodeView,
  reasoning: ReasoningNodeView,
  tool: ToolNodeView,
  question: ({ node }) => <AiQuestionHistory question={node.question} />,
  artifact: ArtifactNodeView,
  approvalMarker: ApprovalMarkerNodeView,
  retry: RetryNodeView,
  error: ErrorNodeView,
  turnProcess: TurnProcessRow,
  turnTail: AiTurnFooter,
} satisfies AiConversationNodeRendererMap;

export const aiAskConversationNodeRenderers = {
  ...aiConversationNodeRenderers,
  reasoning: AskReasoningNodeView,
} satisfies AiConversationNodeRendererMap;

function assertNever(value: never): never {
  throw new Error(`Unsupported AI conversation node: ${JSON.stringify(value)}`);
}

function renderNode(
  node: AiConversationNode,
  renderers: AiConversationNodeRendererMap,
  onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void,
  onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void,
  inTurnProcess = false,
  deferMessageActions = false,
  processControlOnly = false,
  hasResponse = false,
  processPanelIds?: string,
): React.ReactNode {
  switch (node.kind) {
    case 'compaction':
      return React.createElement(renderers.compaction, { node });
    case 'systemPrompt':
      return React.createElement(renderers.systemPrompt, { node, renderers });
    case 'contextInjection':
      return React.createElement(renderers.contextInjection, { node, renderers });
    case 'userMessage':
      return React.createElement(renderers.userMessage, { node });
    case 'assistantMessage':
      return React.createElement(renderers.assistantMessage, { node, inTurnProcess, deferMessageActions });
    case 'reasoning':
      return React.createElement(renderers.reasoning, { node });
    case 'tool':
      return React.createElement(renderers.tool, { node, onOpenTool });
    case 'question':
      return React.createElement(renderers.question, { node });
    case 'artifact':
      return React.createElement(renderers.artifact, { node, onOpenArtifact });
    case 'runtimeArtifacts':
      return null;
    case 'approvalMarker':
      return React.createElement(renderers.approvalMarker, { node });
    case 'retry':
      return React.createElement(renderers.retry, { node });
    case 'error':
      return React.createElement(renderers.error, { node });
    case 'turnProcess':
      return React.createElement(renderers.turnProcess, {
        node,
        renderers,
        onOpenTool,
        onOpenArtifact,
        processControlOnly,
        hasResponse,
        processPanelIds,
      });
    case 'turnTail':
      return React.createElement(renderers.turnTail, { node, renderers });
    default:
      return assertNever(node);
  }
}

export function aiConversationNodeRevision(node: AiConversationNode): string {
  const base = `${node.kind}:${node.key}:${node.lastSeq}`;
  switch (node.kind) {
    // Committed node content is immutable for a given lastSeq. Only optimistic
    // delivery and local presentation state can change without a new event.
    case 'userMessage':
      return `${base}:${node.delivery}:${node.inputKind ?? 'initial'}`;
    case 'assistantMessage':
      return `${base}:${node.state}:${node.hasTurnTail ?? false}:${node.partialReason ?? ''}`;
    case 'reasoning':
      return `${base}:${node.state}`;
    case 'tool':
      return `${base}:${node.state}`;
    case 'question':
      return `${base}:${node.question.status}:${node.lastSeq}`;
    case 'approvalMarker':
      return `${base}:${node.status}`;
    case 'error':
      return `${base}:${node.state}`;
    case 'compaction':
      return `${base}:${node.state}:${node.durationMs ?? 'unknown'}`;
    case 'turnProcess':
      return `${base}:${node.status}:${node.answerGeneration}:${node.hasStartBoundary}:${node.hasEndBoundary}:${node.hasFinalAnswer}:${node.hasInterleavedInput}:${node.children.length}`;
    case 'turnTail':
      return `${base}:${node.status}`;
    case 'systemPrompt':
    case 'contextInjection':
    case 'artifact':
    case 'runtimeArtifacts':
    case 'retry':
      return base;
    default:
      return assertNever(node);
  }
}

const ConversationNodeContent = React.memo(
  function ConversationNodeContent({
    node,
    renderers,
    onOpenTool,
    onOpenArtifact,
    inTurnProcess,
  }: {
    readonly node: AiConversationNode;
    readonly renderers: AiConversationNodeRendererMap;
    readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
    readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
    readonly inTurnProcess?: boolean;
  }) {
    return renderNode(node, renderers, onOpenTool, onOpenArtifact, inTurnProcess);
  },
  (previous, next) =>
    previous.renderers === next.renderers &&
    previous.onOpenTool === next.onOpenTool &&
    previous.onOpenArtifact === next.onOpenArtifact &&
    previous.inTurnProcess === next.inTurnProcess &&
    sameConversationNode(previous.node, next.node),
);

function sameConversationNode(previous: AiConversationNode, next: AiConversationNode): boolean {
  // An earlier turn can receive late usage without changing this tail's seq.
  if (previous.kind === 'turnTail' && next.kind === 'turnTail' && previous.sessionStats !== next.sessionStats) return false;
  return aiConversationNodeRevision(previous) === aiConversationNodeRevision(next);
}

export const AiConversationNodeSeat = React.memo(
  function AiConversationNodeSeat({
    node,
    renderers = aiConversationNodeRenderers,
    onOpenTool,
    onOpenArtifact,
    deferMessageActions = false,
    inTurnProcess = false,
    processControlOnly = false,
    hasResponse = false,
    processPanelIds,
  }: {
    readonly node: AiConversationNode;
    readonly renderers?: AiConversationNodeRendererMap;
    readonly scrollAnchor?: boolean;
    readonly scrollItemId?: string;
    readonly scrollItemClassName?: string;
    readonly deferMessageActions?: boolean;
    readonly inTurnProcess?: boolean;
    readonly processControlOnly?: boolean;
    readonly hasResponse?: boolean;
    readonly processPanelIds?: string;
    readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
    readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
  }) {
    if (node.kind === 'runtimeArtifacts') return null;
    return (
      <div
        className="ai-transcript-flow-item min-w-0 max-w-full"
        data-ai-node-key={node.key}
        data-ai-node-kind={node.kind}
        data-ai-turn-id={node.turnId ?? undefined}
      >
        {renderNode(node, renderers, onOpenTool, onOpenArtifact, inTurnProcess, deferMessageActions, processControlOnly, hasResponse, processPanelIds)}
      </div>
    );
  },
  (previous, next) =>
    previous.renderers === next.renderers &&
    previous.onOpenTool === next.onOpenTool &&
    previous.onOpenArtifact === next.onOpenArtifact &&
    previous.deferMessageActions === next.deferMessageActions &&
    previous.inTurnProcess === next.inTurnProcess &&
    previous.processControlOnly === next.processControlOnly &&
    previous.hasResponse === next.hasResponse &&
    previous.processPanelIds === next.processPanelIds &&
    sameConversationNode(previous.node, next.node),
);
AiConversationNodeSeat.displayName = 'AiConversationNodeSeat';

export function AiConversationNodeList({
  nodes,
  renderers = aiConversationNodeRenderers,
  onOpenTool,
  onOpenArtifact,
}: {
  readonly nodes: readonly AiConversationNode[];
  readonly renderers?: AiConversationNodeRendererMap;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
}) {
  return nodes.map((node) => (
    <AiConversationNodeSeat
      key={node.key}
      node={node}
      renderers={renderers}
      onOpenTool={onOpenTool}
      onOpenArtifact={onOpenArtifact}
      scrollAnchor={node.kind === 'userMessage'}
    />
  ));
}

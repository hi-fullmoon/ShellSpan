import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  AtomIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileInputIcon,
  FileOutputIcon,
  NotebookTextIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from 'lucide-react';

import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { Bubble, Message, MessageActions } from '@/components/ai/chat-primitives';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Marker as MarkerPrimitive,
  MarkerContent,
  MarkerIcon,
} from '@/components/ui/marker';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type {
  AiConversationNode,
  AiConversationNodeOf,
  AiTurnProcessStatus,
} from '@/lib/ai/conversation-node';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { AiToolRow } from './ai-tool-presentation';
import { AiTurnFooter } from './ai-turn-footer';
import { AiQuestionHistory } from './ai-question-panel';

type AiConversationNodeRendererProps<Kind extends AiConversationNode['kind']> = {
  readonly node: AiConversationNodeOf<Kind>;
  readonly inTurnProcess?: boolean;
  readonly renderers?: AiConversationNodeRendererMap;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
};

export type AiConversationNodeRendererMap = {
  readonly [Kind in AiConversationNode['kind']]: React.ComponentType<
    AiConversationNodeRendererProps<Kind>
  >;
};

function assistantText(node: AiConversationNodeOf<'assistantMessage'>): string {
  return node.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

function SemanticNoteDisclosure({
  body,
  icon,
  label,
  summary,
}: {
  readonly body: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly summary?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="ai-semantic-note" data-expanded={open || undefined}>
        <MarkerPrimitive className="ai-semantic-note-marker">
          <CollapsibleTrigger
            render={(
              <Button
                type="button"
                variant="plain"
                size="sm"
                className="ai-disclosure-row"
                aria-label={label}
                aria-expanded={open}
              />
            )}
          >
            <MarkerIcon className="ai-disclosure-leading">
              {icon}
              <ChevronDownIcon className="ai-disclosure-chevron" />
            </MarkerIcon>
            <MarkerContent className="ai-semantic-note-heading">
              <span className="ai-disclosure-title">{label}</span>
              {summary && (
                <>
                  <span className="ai-disclosure-separator" aria-hidden="true" />
                  <span className="ai-disclosure-summary">{summary}</span>
                </>
              )}
            </MarkerContent>
          </CollapsibleTrigger>
        </MarkerPrimitive>
        <CollapsibleContent>
          <Separator className="ai-semantic-note-separator" />
          <div className="ai-semantic-note-body">{body}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function SystemPromptRow({ node }: { readonly node: AiConversationNodeOf<'systemPrompt'> }) {
  const { t } = useI18n();
  return (
    <SemanticNoteDisclosure
      body={node.content}
      icon={<NotebookTextIcon />}
      label={t('ai.workspace.systemPrompt')}
    />
  );
}

function contextLabelKey(
  kind: AiConversationNodeOf<'contextInjection'>['provenance']['kind'],
): LocaleKey {
  switch (kind) {
    case 'runtime': return 'ai.workspace.context.runtime';
    case 'plugin': return 'ai.workspace.context.plugin';
    case 'skill-catalog': return 'ai.workspace.context.skillCatalog';
    case 'agent-instructions': return 'ai.workspace.context.agentInstructions';
    case 'skill-invocation': return 'ai.workspace.context.skillInvocation';
    case 'session-reference': return 'ai.workspace.context.sessionReference';
    case 'form': return 'ai.workspace.context.form';
    case 'user': return 'ai.workspace.context.user';
  }
}

function ContextInjectionRow({
  node,
}: { readonly node: AiConversationNodeOf<'contextInjection'> }) {
  const { t } = useI18n();
  return (
    <SemanticNoteDisclosure
      body={node.loadedSkill
        ? `${t('ai.workspace.skills.instructions')}\n${node.loadedSkill.instructions}\n\n${t('ai.workspace.skills.source')}\n${JSON.stringify(node.loadedSkill.provenance, null, 2)}\nrenderedHash: ${node.loadedSkill.renderedHash}`
        : node.content}
      icon={<FileInputIcon />}
      label={t(contextLabelKey(node.provenance.kind))}
      summary={node.provenance.label}
    />
  );
}

import { AiCommittedImages } from './ai-image-attachments';

function UserMessageNodeView({ node }: { readonly node: AiConversationNodeOf<'userMessage'> }) {
  const { t } = useI18n();
  return (
    <Message role="user">
      <AiCommittedImages sessionId={node.sessionId} images={node.images} />
      {(node.content || node.delivery !== 'committed') && (
        <Bubble role="user">
          <span className="ai-user-message-text">{node.content}</span>
          {node.delivery !== 'committed' && (
            <span className="ai-user-delivery" data-state={node.delivery}>
              {node.delivery === 'failed'
                ? t('ai.workspace.messageNotSent')
                : t('ai.workspace.messagePending')}
            </span>
          )}
        </Bubble>
      )}
      <MessageActions text={node.content} timestamp={node.timestamp} align="end" />
    </Message>
  );
}

function AssistantMessageNodeView({
  node,
  inTurnProcess = false,
}: AiConversationNodeRendererProps<'assistantMessage'>) {
  const { t } = useI18n();
  const text = assistantText(node);
  if (!text) return null;
  return (
    <Message role="assistant">
      <Bubble role="assistant">
        <AssistantMessageContent blocks={node.blocks} streaming={node.state === 'streaming'} />
        {(node.state === 'interrupted' || node.state === 'failed' || node.state === 'cancelled') && (
          <span className="ai-assistant-stopped" data-state={node.state}>
            {node.state === 'failed'
              ? t('ai.message.failed')
              : node.state === 'cancelled'
                ? t('ai.message.cancelled')
                : t('ai.workspace.messageInterrupted')}
          </span>
        )}
      </Bubble>
      {!inTurnProcess && !node.hasTurnTail && node.state !== 'streaming' && (
        <MessageActions
          text={text}
          timestamp={node.timestamp}
          align="start"
          className="ai-assistant-actions"
        />
      )}
    </Message>
  );
}

function ReasoningNodeView({ node }: { readonly node: AiConversationNodeOf<'reasoning'> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isStreaming = node.state === 'streaming';
  const lines = node.content.trim().split('\n');
  const summary = (isStreaming ? lines[lines.length - 1] : lines[0]) || node.summary.trim();
  const title = isStreaming
    ? t('ai.thinking.inProgress')
    : node.state === 'interrupted'
      ? t('ai.thinking.interrupted')
      : t('ai.workspace.reasoning');
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-reasoning-row"
        data-state={isStreaming ? 'running' : node.state === 'interrupted' ? 'interrupted' : 'ok'}
        data-expanded={open || undefined}
        role={isStreaming ? 'status' : undefined}
      >
        <CollapsibleTrigger
          render={(
            <Button
              type="button"
              variant="plain"
              size="sm"
              className="ai-disclosure-row"
              aria-label={summary ? `${title} ${summary}` : title}
              aria-expanded={open}
            />
          )}
        >
          <span className="ai-disclosure-leading" aria-hidden="true">
            <AtomIcon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={cn('ai-disclosure-title', isStreaming && 'shimmer')}>{title}</span>
          {summary && (
            <>
              <span className="ai-disclosure-separator" aria-hidden="true" />
              <span className="ai-disclosure-summary">{summary}</span>
            </>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-reasoning-body">{node.content || node.summary}</div>
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
  return (
    <AiToolRow node={node} onInspect={onOpenTool} />
  );
}

function ArtifactNodeView({
  node,
  onOpenArtifact,
}: {
  readonly node: AiConversationNodeOf<'artifact'>;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-produced-files">
      <span className="ai-produced-files-label">
        <FileOutputIcon aria-hidden="true" />
        {t('ai.workspace.artifact.produced')}
      </span>
      <button
        type="button"
        className="ai-produced-file"
        data-ai-node-action=""
        title={node.title}
        aria-label={t('ai.workspace.details.openArtifact', { artifact: node.title })}
        onClick={() => onOpenArtifact?.(node)}
      >
        <span>{node.title}</span>
        {node.sizeBytes !== null && <small>{node.sizeBytes} B</small>}
      </button>
    </div>
  );
}

function ApprovalMarkerNodeView({
  node,
}: { readonly node: AiConversationNodeOf<'approvalMarker'> }) {
  const { t } = useI18n();
  return (
    <div className="ai-transcript-notice" data-variant="approval" data-state={node.status}>
      <ShieldAlertIcon aria-hidden="true" />
      <span>{t(`ai.workspace.approval.${node.status}` as LocaleKey)}</span>
      {node.prompt && <span className="ai-transcript-notice-detail">{node.prompt}</span>}
    </div>
  );
}

function RetryNodeView({ node }: { readonly node: AiConversationNodeOf<'retry'> }) {
  const { t } = useI18n();
  return (
    <div className="ai-transcript-notice" data-variant="retry">
      <RefreshCwIcon aria-hidden="true" />
      <span>{t('ai.workspace.retry', { attempt: node.attempt })}</span>
      <span className="ai-transcript-notice-detail">{node.reason}</span>
    </div>
  );
}

function ErrorNodeView({ node }: { readonly node: AiConversationNodeOf<'error'> }) {
  const { t } = useI18n();
  return (
    <div className="ai-turn-error" role="alert">
      <CircleAlertIcon aria-hidden="true" />
      <div className="ai-turn-error-copy">
        <strong>{t('ai.requestFailed')}</strong>
        <span>{node.message}</span>
      </div>
      {node.code && <code>{node.code}</code>}
    </div>
  );
}

interface StoredTurnProcessDisclosure {
  readonly open: boolean;
  readonly status: AiTurnProcessStatus;
}

const TURN_PROCESS_DISCLOSURE_LIMIT = 512;
const turnProcessDisclosures = new Map<string, StoredTurnProcessDisclosure>();

function turnProcessDisclosureKey(node: AiConversationNodeOf<'turnProcess'>): string {
  return `${node.sessionId}:${node.turnId ?? 'unscoped'}:${node.answerGeneration}`;
}

function storeTurnProcessDisclosure(
  key: string,
  value: StoredTurnProcessDisclosure,
): void {
  turnProcessDisclosures.delete(key);
  turnProcessDisclosures.set(key, value);
  if (turnProcessDisclosures.size <= TURN_PROCESS_DISCLOSURE_LIMIT) return;
  const oldest = turnProcessDisclosures.keys().next().value as string | undefined;
  if (oldest !== undefined) turnProcessDisclosures.delete(oldest);
}

function isSettledTurnProcess(status: AiTurnProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function turnProcessLabelKey(status: AiTurnProcessStatus): LocaleKey {
  switch (status) {
    case 'running': return 'ai.workspace.turnProcess.running';
    case 'waiting': return 'ai.workspace.turnProcess.waiting';
    case 'completed': return 'ai.workspace.turnProcess.completed';
    case 'failed': return 'ai.workspace.turnProcess.failed';
    case 'cancelled': return 'ai.workspace.turnProcess.cancelled';
    case 'partial': return 'ai.workspace.turnProcess.partial';
  }
}

function turnProcessSummary(
  node: AiConversationNodeOf<'turnProcess'>,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const counts = new Map<AiConversationNodeOf<'turnProcess'>['children'][number]['kind'], number>();
  for (const child of node.children) counts.set(child.kind, (counts.get(child.kind) ?? 0) + 1);
  const parts = [
    ['tool', 'ai.workspace.turnProcess.toolCount'],
    ['retry', 'ai.workspace.turnProcess.retryCount'],
    ['error', 'ai.workspace.turnProcess.errorCount'],
  ] as const;
  return parts.flatMap(([kind, key]) => {
    const count = counts.get(kind) ?? 0;
    return count === 0 ? [] : [t(key, { count })];
  }).join(t('ai.workspace.turnProcess.separator'));
}

function TurnProcessDisclosure({
  node,
  onOpenArtifact,
  onOpenTool,
  renderers,
}: {
  readonly node: AiConversationNodeOf<'turnProcess'>;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
  readonly renderers: AiConversationNodeRendererMap;
}) {
  const { t } = useI18n();
  const stateKey = turnProcessDisclosureKey(node);
  const stored = turnProcessDisclosures.get(stateKey);
  const [open, setOpen] = useState(stored?.open ?? !isSettledTurnProcess(node.status));
  const previousStatusRef = useRef(stored?.status ?? node.status);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = t(turnProcessLabelKey(node.status));
  const summary = turnProcessSummary(node, t);

  const updateOpen = (next: boolean): void => {
    storeTurnProcessDisclosure(stateKey, { open: next, status: node.status });
    setOpen(next);
  };

  useLayoutEffect(() => {
    const previousStatus = previousStatusRef.current;
    if (!isSettledTurnProcess(previousStatus) && isSettledTurnProcess(node.status)) {
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      storeTurnProcessDisclosure(stateKey, { open: false, status: node.status });
      setOpen(false);
    } else {
      storeTurnProcessDisclosure(stateKey, { open, status: node.status });
    }
    previousStatusRef.current = node.status;
  }, [node.status, open, stateKey]);

  return (
    <Collapsible open={open} onOpenChange={updateOpen}>
      <div
        ref={rootRef}
        className="ai-turn-process"
        data-expanded={open || undefined}
        data-status={node.status}
        data-answer-generation={node.answerGeneration}
      >
        <CollapsibleTrigger
          render={(
            <Button
              ref={triggerRef}
              type="button"
              variant="plain"
              size="sm"
              className="ai-disclosure-row ai-turn-process-trigger"
              aria-label={label}
              aria-expanded={open}
            />
          )}
        >
          <span className="ai-disclosure-leading" aria-hidden="true">
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className="ai-disclosure-title">{label}</span>
          {summary && (
            <>
              <span className="ai-disclosure-separator" aria-hidden="true" />
              <span className="ai-disclosure-summary">{summary}</span>
            </>
          )}
        </CollapsibleTrigger>
        <Separator className="ai-turn-process-separator" />
        <CollapsibleContent>
          <div className="ai-turn-process-body">
            {node.children.map((child) => (
              <div
                key={child.key}
                className="ai-turn-process-child"
                data-ai-process-child={child.kind}
                data-ai-process-child-key={child.key}
              >
                {renderNode(child, renderers, onOpenTool, onOpenArtifact, true)}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function TurnProcessRow({
  node,
  onOpenArtifact,
  onOpenTool,
  renderers = aiConversationNodeRenderers,
}: AiConversationNodeRendererProps<'turnProcess'>) {
  if (node.children.length === 0) return null;
  const key = turnProcessDisclosureKey(node);
  return (
    <TurnProcessDisclosure
      key={key}
      node={node}
      renderers={renderers}
      onOpenTool={onOpenTool}
      onOpenArtifact={onOpenArtifact}
    />
  );
}

export const aiConversationNodeRenderers = {
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

function assertNever(value: never): never {
  throw new Error(`Unsupported AI conversation node: ${JSON.stringify(value)}`);
}

function renderNode(
  node: AiConversationNode,
  renderers: AiConversationNodeRendererMap,
  onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void,
  onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void,
  inTurnProcess = false,
): React.ReactNode {
  switch (node.kind) {
    case 'systemPrompt': return React.createElement(renderers.systemPrompt, { node, renderers });
    case 'contextInjection': return React.createElement(renderers.contextInjection, { node, renderers });
    case 'userMessage': return React.createElement(renderers.userMessage, { node });
    case 'assistantMessage': return React.createElement(renderers.assistantMessage, { node, inTurnProcess });
    case 'reasoning': return React.createElement(renderers.reasoning, { node });
    case 'tool': return React.createElement(renderers.tool, { node, onOpenTool });
    case 'question': return React.createElement(renderers.question, { node });
    case 'artifact': return React.createElement(renderers.artifact, { node, onOpenArtifact });
    case 'approvalMarker': return React.createElement(renderers.approvalMarker, { node });
    case 'retry': return React.createElement(renderers.retry, { node });
    case 'error': return React.createElement(renderers.error, { node });
    case 'turnProcess': return React.createElement(renderers.turnProcess, {
      node, renderers, onOpenTool, onOpenArtifact,
    });
    case 'turnTail': return React.createElement(renderers.turnTail, { node, renderers });
    default: return assertNever(node);
  }
}

export function aiConversationNodeRevision(node: AiConversationNode): string {
  const base = `${node.kind}:${node.key}:${node.lastSeq}`;
  switch (node.kind) {
    case 'systemPrompt': return `${base}:${node.requestIds.join(',')}:${node.content}`;
    case 'contextInjection': return `${base}:${node.provenance.kind}:${node.content}`;
    case 'userMessage': return `${base}:${node.delivery}:${node.content}`;
    case 'assistantMessage': return `${base}:${node.state}:${node.hasTurnTail ?? false}:${JSON.stringify(node.blocks)}`;
    case 'reasoning': return `${base}:${node.state}:${node.summary}:${node.content}`;
    case 'tool': return `${base}:${node.state}:${node.durationMs ?? ''}:${node.error ?? ''}`;
    case 'question': return `${base}:${node.question.status}:${node.lastSeq}`;
    case 'artifact': return `${base}:${node.sha256}:${node.sizeBytes ?? ''}`;
    case 'approvalMarker': return `${base}:${node.status}:${node.prompt ?? ''}`;
    case 'retry': return `${base}:${node.attempt}:${node.reason}`;
    case 'error': return `${base}:${node.state}:${node.code ?? ''}:${node.message}`;
    case 'turnProcess': return `${base}:${node.status}:${node.answerGeneration}:${node.hasStartBoundary}:${node.hasEndBoundary}:${node.children.map(aiConversationNodeRevision).join('|')}`;
    case 'turnTail': return `${base}:${node.status}:${node.endReason}:${JSON.stringify(node.stats)}:${JSON.stringify(node.sessionStats)}:${node.summaryText ?? ''}:${node.durationMs ?? ''}:${JSON.stringify(node.models)}`;
    default: return assertNever(node);
  }
}

export const AiConversationNodeSeat = React.memo(function AiConversationNodeSeat({
  node,
  renderers = aiConversationNodeRenderers,
  onOpenTool,
  onOpenArtifact,
}: {
  readonly node: AiConversationNode;
  readonly renderers?: AiConversationNodeRendererMap;
  readonly scrollAnchor?: boolean;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
}) {
  return (
    <div
      className="ai-transcript-flow-item min-w-0"
      data-ai-node-key={node.key}
      data-ai-node-kind={node.kind}
      data-ai-turn-id={node.turnId ?? undefined}
    >
      {renderNode(node, renderers, onOpenTool, onOpenArtifact)}
    </div>
  );
}, (previous, next) => (
  previous.renderers === next.renderers
  && previous.onOpenTool === next.onOpenTool
  && previous.onOpenArtifact === next.onOpenArtifact
  && aiConversationNodeRevision(previous.node) === aiConversationNodeRevision(next.node)
));
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

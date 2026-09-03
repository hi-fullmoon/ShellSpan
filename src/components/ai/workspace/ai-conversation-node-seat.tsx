import React, { useState } from 'react';
import {
  BrainCircuitIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleXIcon,
  Clock3Icon,
  FileOutputIcon,
  ShieldAlertIcon,
} from 'lucide-react';

import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { Bubble, Marker, Message } from '@/components/ai/chat-primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import type {
  AiConversationNode,
  AiConversationNodeOf,
} from '@/lib/ai/conversation-node';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';

export type AiConversationNodeRendererMap = {
  readonly [Kind in AiConversationNode['kind']]: React.ComponentType<{
    readonly node: AiConversationNodeOf<Kind>;
    readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
    readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
  }>;
};

function UserMessageNodeView({ node }: { readonly node: AiConversationNodeOf<'userMessage'> }) {
  const { t } = useI18n();
  return (
    <Message role="user">
      <Bubble role="user">
        <span>{node.content}</span>
        {node.delivery !== 'committed' && (
          <span className={cn(
            'mt-1 block text-xs',
            node.delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}>
            {node.delivery === 'failed'
              ? t('ai.workspace.messageNotSent')
              : t('ai.workspace.messagePending')}
          </span>
        )}
      </Bubble>
    </Message>
  );
}

function AssistantMessageNodeView({
  node,
}: { readonly node: AiConversationNodeOf<'assistantMessage'> }) {
  const { t } = useI18n();
  if (!node.content && node.state === 'streaming') return null;
  return (
    <Message role="assistant">
      <Bubble role="assistant">
        <AssistantMessageContent content={node.content} streaming={false} />
        {(node.state === 'interrupted' || node.state === 'failed' || node.state === 'cancelled') && (
          <span className={cn(
            'text-xs',
            node.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}>
            {node.state === 'failed'
              ? t('ai.message.failed')
              : node.state === 'cancelled'
                ? t('ai.message.cancelled')
                : t('ai.workspace.messageInterrupted')}
          </span>
        )}
      </Bubble>
    </Message>
  );
}

function ReasoningNodeView({ node }: { readonly node: AiConversationNodeOf<'reasoning'> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = node.summary || t('ai.thinking');
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={(
          <Button
            variant="plain"
            size="sm"
            className="h-8 w-full min-w-0 justify-start px-0 text-muted-foreground"
            aria-label={open
              ? t('ai.workspace.reasoningCollapse')
              : t('ai.workspace.reasoningExpand')}
          />
        )}
      >
        <BrainCircuitIcon data-icon="inline-start" />
        <span className="shrink-0">{t('ai.thinking')}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronRightIcon
          data-icon="inline-end"
          className={cn('transition-transform', open && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-3 overflow-x-auto border-l border-border py-1 pl-3 text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
          {node.content || node.summary}
        </div>
      </CollapsibleContent>
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
  const { t } = useI18n();
  const stateKey = `ai.workspace.tool.${node.state}` as LocaleKey;
  const StateIcon = node.state === 'succeeded'
    ? CheckCircle2Icon
    : node.state === 'failed' || node.state === 'rejected'
      ? CircleXIcon
      : node.state === 'approval'
        ? ShieldAlertIcon
        : node.state === 'running'
          ? Clock3Icon
          : CircleDashedIcon;
  return (
    <button
      type="button"
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md text-left text-sm text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      data-tool-state={node.state}
      data-ai-node-action=""
      aria-label={t('ai.workspace.details.openTool', { tool: node.name })}
      onClick={() => onOpenTool?.(node)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
        <StateIcon />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{node.name}</span>
        {node.summary && <span> · {node.summary}</span>}
      </span>
      <span className="shrink-0 text-xs">{t(stateKey)}</span>
      {node.durationMs !== null && (
        <span className="shrink-0 text-xs">{t('ai.workspace.durationMs', { duration: node.durationMs })}</span>
      )}
      <ChevronRightIcon aria-hidden="true" />
    </button>
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
    <button
      type="button"
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md text-left text-sm text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      data-ai-node-action=""
      aria-label={t('ai.workspace.details.openArtifact', { artifact: node.title })}
      onClick={() => onOpenArtifact?.(node)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
        <FileOutputIcon />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{node.title}</span>
        <span> · {node.artifactKind}</span>
      </span>
      {node.sizeBytes !== null && <span className="shrink-0 text-xs">{node.sizeBytes} B</span>}
      <ChevronRightIcon aria-hidden="true" />
    </button>
  );
}

function ApprovalMarkerNodeView({
  node,
}: { readonly node: AiConversationNodeOf<'approvalMarker'> }) {
  const { t } = useI18n();
  return (
    <Marker>
      {t(`ai.workspace.approval.${node.status}` as LocaleKey)}
      {node.prompt ? ` · ${node.prompt}` : ''}
    </Marker>
  );
}

function LifecycleMarkerNodeView({
  node,
}: { readonly node: AiConversationNodeOf<'lifecycleMarker'> }) {
  const { t } = useI18n();
  return (
    <Marker>
      {t(`ai.workspace.marker.${node.category}` as LocaleKey)}
      {node.detail ? ` · ${node.detail}` : ''}
    </Marker>
  );
}

function RetryNodeView({ node }: { readonly node: AiConversationNodeOf<'retry'> }) {
  const { t } = useI18n();
  return <Marker>{t('ai.workspace.retry', { attempt: node.attempt })} · {node.reason}</Marker>;
}

function ErrorNodeView({ node }: { readonly node: AiConversationNodeOf<'error'> }) {
  const { t } = useI18n();
  return (
    <Alert variant="destructive" size="sm">
      <CircleAlertIcon />
      <AlertTitle>{t('ai.requestFailed')}</AlertTitle>
      <AlertDescription className="min-w-0 break-words">
        {node.message}
        {node.code && <code className="ml-1 break-all">{node.code}</code>}
      </AlertDescription>
    </Alert>
  );
}

export const aiConversationNodeRenderers = {
  userMessage: UserMessageNodeView,
  assistantMessage: AssistantMessageNodeView,
  reasoning: ReasoningNodeView,
  tool: ToolNodeView,
  artifact: ArtifactNodeView,
  approvalMarker: ApprovalMarkerNodeView,
  lifecycleMarker: LifecycleMarkerNodeView,
  retry: RetryNodeView,
  error: ErrorNodeView,
} satisfies AiConversationNodeRendererMap;

function assertNever(value: never): never {
  throw new Error(`Unsupported AI conversation node: ${JSON.stringify(value)}`);
}

function renderNode(
  node: AiConversationNode,
  renderers: AiConversationNodeRendererMap,
  onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void,
  onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void,
): React.ReactNode {
  switch (node.kind) {
    case 'userMessage': return React.createElement(renderers.userMessage, { node });
    case 'assistantMessage': return React.createElement(renderers.assistantMessage, { node });
    case 'reasoning': return React.createElement(renderers.reasoning, { node });
    case 'tool': return React.createElement(renderers.tool, { node, onOpenTool });
    case 'artifact': return React.createElement(renderers.artifact, { node, onOpenArtifact });
    case 'approvalMarker': return React.createElement(renderers.approvalMarker, { node });
    case 'lifecycleMarker': return React.createElement(renderers.lifecycleMarker, { node });
    case 'retry': return React.createElement(renderers.retry, { node });
    case 'error': return React.createElement(renderers.error, { node });
    default: return assertNever(node);
  }
}

export function aiConversationNodeRevision(node: AiConversationNode): string {
  const base = `${node.kind}:${node.key}:${node.lastSeq}`;
  switch (node.kind) {
    case 'userMessage': return `${base}:${node.delivery}:${node.content}`;
    case 'assistantMessage': return `${base}:${node.state}:${node.content}`;
    case 'reasoning': return `${base}:${node.state}:${node.summary}:${node.content}`;
    case 'tool': return `${base}:${node.state}:${node.durationMs ?? ''}:${node.error ?? ''}`;
    case 'artifact': return `${base}:${node.sha256}:${node.sizeBytes ?? ''}`;
    case 'approvalMarker': return `${base}:${node.status}:${node.prompt ?? ''}`;
    case 'lifecycleMarker': return `${base}:${node.category}:${node.detail ?? ''}`;
    case 'retry': return `${base}:${node.attempt}:${node.reason}`;
    case 'error': return `${base}:${node.state}:${node.code ?? ''}:${node.message}`;
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
      className="min-w-0"
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

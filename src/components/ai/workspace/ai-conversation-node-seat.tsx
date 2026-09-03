import React, { useState } from 'react';
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDotDashedIcon,
  FileOutputIcon,
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
import { useI18n } from '@/hooks/useI18n';
import type {
  AiConversationNode,
  AiConversationNodeOf,
} from '@/lib/ai/conversation-node';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/utils';
import { AiToolRow } from './ai-tool-presentation';

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
        <span className="ai-user-message-text">{node.content}</span>
        {node.delivery !== 'committed' && (
          <span className="ai-user-delivery" data-state={node.delivery}>
            {node.delivery === 'failed'
              ? t('ai.workspace.messageNotSent')
              : t('ai.workspace.messagePending')}
          </span>
        )}
      </Bubble>
      <MessageActions text={node.content} timestamp={node.timestamp} align="end" />
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
        <AssistantMessageContent content={node.content} streaming={node.state === 'streaming'} />
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
      {node.content && (
        <MessageActions
          text={node.content}
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
  const lines = node.content.trim().split('\n');
  const label = node.state === 'streaming'
    ? lines[lines.length - 1] || node.summary || t('ai.thinking.inProgress')
    : lines[0] || node.summary || t('ai.thinking');
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn('ai-reasoning-row', node.state === 'streaming' && 'shimmer')}
        data-state={node.state === 'streaming' ? 'running' : 'ok'}
        data-expanded={open || undefined}
      >
        <CollapsibleTrigger
          render={(
            <Button
              variant="plain"
              size="sm"
              className="ai-disclosure-row"
              aria-label={open
                ? t('ai.workspace.reasoningCollapse')
                : t('ai.workspace.reasoningExpand')}
            />
          )}
        >
          <span className="ai-disclosure-leading" aria-hidden="true">
            <CircleDotDashedIcon />
          </span>
          <span className="ai-disclosure-title">
            {node.state === 'streaming' ? t('ai.thinking.inProgress') : t('ai.thinking')}
          </span>
          <span className="ai-disclosure-separator" aria-hidden="true" />
          <span className="ai-disclosure-summary">{label}</span>
          <ChevronRightIcon className="ai-disclosure-chevron" aria-hidden="true" />
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

function LifecycleMarkerNodeView({
  node,
}: { readonly node: AiConversationNodeOf<'lifecycleMarker'> }) {
  const { t } = useI18n();
  return (
    <div className="ai-transcript-notice" data-variant="lifecycle" data-state={node.state}>
      <CircleDotDashedIcon aria-hidden="true" />
      <span>{t(`ai.workspace.marker.${node.category}` as LocaleKey)}</span>
      {node.detail && <span className="ai-transcript-notice-detail">{node.detail}</span>}
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

function compactDuration(milliseconds: number): string {
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function TurnStatsNodeView({ node }: { readonly node: AiConversationNodeOf<'turnStats'> }) {
  const { t } = useI18n();
  const groups = [
    [
      { key: 'turn', text: t('ai.workspace.stats.turn', { count: node.turnNumber }) },
      { key: 'steps', text: t('ai.workspace.stats.steps', { count: node.stepCount }) },
    ],
    [
      node.modelDurationMs === null ? null : {
        key: 'model',
        text: t('ai.workspace.stats.model', { duration: compactDuration(node.modelDurationMs) }),
      },
      node.toolDurationMs === null ? null : {
        key: 'tools',
        text: t('ai.workspace.stats.tools', { duration: compactDuration(node.toolDurationMs) }),
      },
    ],
    [
      node.averageTimeToFirstTokenMs === null ? null : {
        key: 'ttft',
        text: t('ai.workspace.stats.ttft', { duration: compactDuration(node.averageTimeToFirstTokenMs) }),
      },
      node.tokensPerSecond === null ? null : {
        key: 'rate',
        text: t('ai.workspace.stats.rate', { rate: Math.round(node.tokensPerSecond) }),
      },
    ],
    [
      node.inputTokens === null ? null : {
        key: 'inputTokens',
        text: t('ai.workspace.stats.inputTokens', { count: node.inputTokens }),
      },
      node.outputTokens === null ? null : {
        key: 'outputTokens',
        text: t('ai.workspace.stats.outputTokens', { count: node.outputTokens }),
      },
      node.inputTokens !== null || node.outputTokens !== null || node.totalTokens === null ? null : {
        key: 'tokens',
        text: t('ai.workspace.stats.tokens', { count: node.totalTokens }),
      },
    ],
  ].map((group) => group.filter(
    (item): item is { key: string; text: string } => item !== null,
  )).filter((group) => group.length > 0);
  const line = groups.map((group) => group.map((stat) => stat.text).join(' · ')).join(' | ');
  return (
    <div className="ai-turn-stats" aria-label={t('ai.workspace.stats.label')} title={line}>
      {groups.map((group) => (
        <span key={group.map((stat) => stat.key).join(':')} data-stat-group="">
          {group.map((stat, index) => (
            <React.Fragment key={stat.key}>
              {index > 0 && <span className="ai-turn-stats-inner-separator" aria-hidden="true">·</span>}
              <span data-stat={stat.key}>{stat.text}</span>
            </React.Fragment>
          ))}
        </span>
      ))}
    </div>
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
  turnStats: TurnStatsNodeView,
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
    case 'turnStats': return React.createElement(renderers.turnStats, { node });
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
    case 'turnStats': return `${base}:${node.turnNumber}:${node.stepCount}:${node.modelDurationMs ?? ''}:${node.toolDurationMs ?? ''}:${node.averageTimeToFirstTokenMs ?? ''}:${node.totalTokens ?? ''}`;
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

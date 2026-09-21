import { memo, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { BrainIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import type { AiConversationNode, AiConversationNodeOf, AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { useConversationHistory } from './use-conversation-history';
import { MessageScroller } from '../chat-primitives';
import {
  AiConversationNodeSeat,
  type AiConversationNodeRendererMap,
} from './ai-conversation-node-seat';

const statusItemClassName = '[content-visibility:visible] [contain-intrinsic-size:none]';
const HISTORY_PAGE_SIZE = 80;

const AskThinkingIndicator = memo(function AskThinkingIndicator(_: { scrollItemClassName: string }) {
  const { t } = useI18n();
  return (
    <Marker
      className="ai-turn-status inline-flex min-h-6.5 w-fit self-start items-center gap-1 whitespace-nowrap"
      role="status"
      aria-live="polite"
      data-ai-thinking-indicator=""
    >
      <MarkerIcon>
        <BrainIcon aria-hidden="true" />
      </MarkerIcon>
      <MarkerContent className="shimmer">{t('ai.thinking.inProgress')}</MarkerContent>
    </Marker>
  );
});

const AgentRunningIndicator = memo(function AgentRunningIndicator({
  status,
}: {
  readonly status: AiSessionStatus;
  readonly scrollItemClassName: string;
}) {
  const { t } = useI18n();
  return (
    <Marker
      className="ai-turn-status inline-flex min-h-6.5 w-fit self-start items-center gap-1 whitespace-nowrap"
      role="status"
      aria-live="polite"
      data-ai-running-indicator=""
    >
      <MarkerContent className="shimmer">
        {status === 'waiting' ? t('agent.session.status.waiting') : t('ai.workspace.processing')}
      </MarkerContent>
    </Marker>
  );
});

function followKey(nodes: readonly AiConversationNode[], throughSeq: number | null): string {
  const last = nodes[nodes.length - 1];
  const contentRevision = last?.kind === 'assistantMessage'
    ? last.blocks.reduce((sum, block) => (
      block.type === 'text' || block.type === 'reasoning' ? sum + block.text.length : sum
    ), 0)
    : last?.kind === 'reasoning' ? last.content.length : 0;
  return `${throughSeq ?? 'uncommitted'}:${last?.key ?? 'empty'}:${last?.lastSeq ?? 0}:${contentRevision}`;
}

function conversationItemId(node: AiConversationNode): string {
  return node.kind === 'userMessage'
    ? `user:${node.clientSubmissionId ?? node.messageId}`
    : node.key;
}

const ConversationRow = memo(function ConversationRow({ indicator, ...props }:
  ComponentProps<typeof AiConversationNodeSeat> & { indicator?: ReactNode }) {
  return <>
    <AiConversationNodeSeat {...props} />
    {indicator && (props.node.kind === 'turnTail' ? <div className="ml-1.5">{indicator}</div> : indicator)}
  </>;
});

export interface AiConversationProps {
  readonly nodes: readonly AiConversationNode[];
  readonly renderers?: AiConversationNodeRendererMap;
  readonly runningIndicator?: 'agent' | 'ask' | 'none';
  readonly pending?: boolean;
  readonly submittedOperationId?: string;
  readonly imageSubmissionId?: string;
  readonly status: AiSessionStatus;
  readonly throughSeq: number | null;
  readonly initialAnchor?: AiScrollAnchor;
  readonly onAnchorChange?: (anchor: AiScrollAnchor) => void;
  readonly onOpenTool?: (node: AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: AiConversationNodeOf<'artifact'>) => void;
  readonly canLoadOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly onLoadOlder?: () => void;
}

export const AiConversation = memo(function AiConversation({
  nodes: allNodes,
  renderers,
  runningIndicator = 'agent',
  pending = false,
  status,
  throughSeq,
  initialAnchor,
  onAnchorChange,
  onOpenTool,
  onOpenArtifact,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: AiConversationProps): React.ReactNode {
  const { t } = useI18n();
  const { nodes, startIndex, saveAnchor, revealOlder, resumeFollowing } = useConversationHistory(
    allNodes, HISTORY_PAGE_SIZE, initialAnchor, onAnchorChange, onLoadOlder,
  );
  const running = status === 'running' || status === 'waiting';
  let latestUserIndex = -1;
  for (let index = allNodes.length - 1; index >= 0; index -= 1) {
    if (allNodes[index]?.kind === 'userMessage') {
      latestUserIndex = index;
      break;
    }
  }
  const visibleResponseStarted = allNodes.slice(latestUserIndex + 1).some((node) => (
    node.kind === 'reasoning'
    || node.kind === 'question'
    || node.kind === 'error'
    || (node.kind === 'assistantMessage'
      && node.blocks.some((block) => block.type === 'text' && block.text.length > 0))
  ));
  const showAskThinking = (running || pending)
    && runningIndicator === 'ask'
    && !visibleResponseStarted;
  const latestUser = latestUserIndex >= 0 ? allNodes[latestUserIndex] : undefined;
  const latestUserKey = latestUser ? conversationItemId(latestUser) : undefined;
  // Keep the trailing status in the last message row. A separate status item
  // would hide an inserted user row from the primitive's append detection.
  const indicator = showAskThinking
    ? <AskThinkingIndicator scrollItemClassName={statusItemClassName} />
    : (running || pending) && runningIndicator === 'agent'
      ? <AgentRunningIndicator status={status} scrollItemClassName={statusItemClassName} />
      : null;
  return (
    <MessageScroller
      className="min-h-0 flex-1"
      contentClassName="ai-conversation-content mx-auto min-w-0 w-[min(calc(100%-var(--ai-shell-clearance)-var(--ai-transcript-extra-inset)-var(--ai-shell-clearance)-var(--ai-transcript-extra-inset)),var(--ai-chat-content-max-width))] gap-4 px-0 pt-5 pb-7"
      followKey={followKey(nodes, throughSeq)}
      ariaLabel={t('ai.conversation')}
      initialAnchor={initialAnchor}
      onAnchorChange={saveAnchor}
      onFollowLatest={resumeFollowing}
      header={(startIndex > 0 || canLoadOlder) && (
        <div className="ai-load-older flex justify-center py-1">
          <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={revealOlder}>
            {loadingOlder ? t('common.loading') : t('ai.workspace.loadOlder')}
          </Button>
        </div>
      )}
    >
      {nodes.map((node, index) => (
        <ConversationRow
          key={conversationItemId(node)}
          node={node}
          renderers={renderers}
          // The primitive owns turn alignment, shrinking its spacer as output
          // grows. Stable submission IDs keep acknowledgement from reanchoring.
          scrollAnchor={conversationItemId(node) === latestUserKey}
          scrollItemId={conversationItemId(node)}
          scrollItemClassName={cn(
            'flex flex-col gap-4',
            node.kind === 'turnTail' && '-ml-1.5',
            index + startIndex >= latestUserIndex && '[content-visibility:visible] [contain-intrinsic-size:none]',
          )}
          onOpenTool={onOpenTool}
          onOpenArtifact={onOpenArtifact}
          indicator={index === nodes.length - 1 ? indicator : undefined}
        />
      ))}
      {!nodes.length && indicator}
    </MessageScroller>
  );
});

import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNode, AiConversationNodeOf, AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { MessageScroller } from '../chat-primitives';
import { AiConversationNodeSeat } from './ai-conversation-node-seat';

function followKey(nodes: readonly AiConversationNode[], throughSeq: number | null): string {
  const last = nodes[nodes.length - 1];
  const contentRevision = last?.kind === 'assistantMessage'
    ? last.blocks.reduce((sum, block) => (
      block.type === 'text' || block.type === 'reasoning' ? sum + block.text.length : sum
    ), 0)
    : last?.kind === 'reasoning' ? last.content.length : 0;
  return `${throughSeq ?? 'uncommitted'}:${last?.key ?? 'empty'}:${last?.lastSeq ?? 0}:${contentRevision}`;
}

export interface AiConversationProps {
  readonly nodes: readonly AiConversationNode[];
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

export function AiConversation({
  nodes,
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
  const running = status === 'running' || status === 'waiting';
  return (
    <MessageScroller
      className="min-h-0 flex-1"
      contentClassName="ai-conversation-content"
      followKey={followKey(nodes, throughSeq)}
      ariaLabel={t('ai.conversation')}
      initialAnchor={initialAnchor}
      onAnchorChange={onAnchorChange}
    >
      {canLoadOlder && (
        <div className="ai-load-older">
          <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={onLoadOlder}>
            {loadingOlder ? t('common.loading') : t('ai.workspace.loadOlder')}
          </Button>
        </div>
      )}
      {nodes.map((node) => (
        <AiConversationNodeSeat
          key={node.key}
          node={node}
          scrollAnchor={node.kind === 'userMessage'}
          onOpenTool={onOpenTool}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
      {running && (
        <div
          className="ai-turn-status shimmer"
          role="status"
          aria-live="polite"
          data-ai-running-indicator=""
        >
          <span>{status === 'waiting' ? t('agent.session.status.waiting') : t('agent.outcome.running')}</span>
        </div>
      )}
    </MessageScroller>
  );
}

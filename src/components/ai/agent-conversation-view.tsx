import { BotIcon } from 'lucide-react';

import { AgentToolRow } from '@/components/ai/agent-tool-row';
import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { Bubble, Marker, Message, MessageScroller } from '@/components/ai/chat-primitives';
import { PanelEmptyState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type {
  AgentConversationMarkerItem,
  AgentConversationProjection,
  AgentConversationToolItem,
} from '@/types/agent-session';

function markerText(
  marker: AgentConversationMarkerItem,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (marker.marker) {
    case 'steer': return t('agent.session.marker.steer', { detail: marker.detail ?? '' });
    case 'runtime': return t('agent.session.marker.runtime', { detail: marker.detail ?? '' });
    case 'retry': return t('agent.session.marker.retry', {
      attempt: marker.count ?? 1,
      detail: marker.detail ?? '',
    });
    case 'compaction': return t('agent.session.marker.compaction', {
      generation: marker.count ?? 0,
    });
    case 'contextLimited': return t('agent.session.marker.contextLimited');
    case 'artifact': return t('agent.session.marker.artifact', { detail: marker.detail ?? '' });
    case 'recovery': return t('agent.session.marker.recovery', { detail: marker.detail ?? '' });
    case 'subagentSettled': return t('agent.session.marker.subagentSettled', {
      session: marker.sessionId ?? '',
      detail: marker.detail ?? '',
    });
    case 'failed': return marker.detail
      ? t('agent.session.marker.failedDetail', { detail: marker.detail })
      : t('agent.session.marker.failed');
    case 'cancelled': return marker.detail
      ? t('agent.session.marker.cancelledDetail', { detail: marker.detail })
      : t('agent.session.marker.cancelled');
    case 'maxTokens': return t('agent.session.marker.maxTokens');
    case 'discarded': return t('agent.session.marker.discarded');
    case 'status': return marker.detail ?? t('agent.session.marker.status');
  }
}

export interface AgentConversationViewProps {
  readonly projection: AgentConversationProjection;
  readonly renderTool?: (tool: AgentConversationToolItem) => React.ReactNode;
}

export function AgentConversationView({
  projection,
  renderTool,
}: AgentConversationViewProps): React.ReactNode {
  const { t } = useI18n();

  if (projection.items.length === 0) {
    return (
      <PanelEmptyState
        icon={<BotIcon />}
        title={t('agent.emptyTitle')}
        description={t('agent.emptyDescription')}
      />
    );
  }

  return (
    <MessageScroller
      className="flex-1"
      contentClassName="pt-2"
      followKey={projection.followKey}
      ariaLabel={t('agent.conversation')}
    >
      {projection.items.map((item) => {
        if (item.kind === 'marker') {
          return (
            <Marker key={item.id} variant="separator">
              {markerText(item, t)}
            </Marker>
          );
        }
        if (item.kind === 'tool') {
          return (
            <div key={item.id} data-agent-tool-id={item.callId}>
              {renderTool?.(item) ?? <AgentToolRow tool={item} />}
            </div>
          );
        }
        return (
          <Message key={item.id} role={item.role}>
            <Bubble role={item.role}>
              {item.role === 'assistant' ? (
                item.content
                  ? <AssistantMessageContent content={item.content} streaming={item.status === 'streaming'} />
                  : <span className="shimmer text-muted-foreground">{t('agent.phase.analyzing')}</span>
              ) : item.content}
            </Bubble>
          </Message>
        );
      })}
    </MessageScroller>
  );
}

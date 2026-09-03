import { useEffect, useState } from 'react';
import { ActivityIcon, MessageSquareIcon } from 'lucide-react';

import { AgentActivityView } from '@/components/ai/agent-activity-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import type { AiConversationProps } from './ai-conversation';
import { AiConversation } from './ai-conversation';

export type AiWorkspaceTab = 'conversation' | 'activity';

export interface AiSessionTabsProps {
  readonly view: AiSessionView;
  readonly selectedTab?: AiWorkspaceTab;
  readonly onSelectedTabChange?: (tab: AiWorkspaceTab) => void;
  readonly activityContent?: React.ReactNode;
  readonly conversationProps?: Omit<AiConversationProps, 'nodes' | 'status' | 'throughSeq'>;
}

export function AiSessionTabs({
  view,
  selectedTab,
  onSelectedTabChange,
  activityContent,
  conversationProps,
}: AiSessionTabsProps): React.ReactNode {
  const { t } = useI18n();
  const [localTab, setLocalTab] = useState<AiWorkspaceTab>('conversation');
  const tab = selectedTab ?? localTab;
  const hasActivity = view.summary.kind === 'agent' && view.activity !== null;

  useEffect(() => {
    if (!hasActivity && tab !== 'conversation') {
      if (selectedTab === undefined) setLocalTab('conversation');
      onSelectedTabChange?.('conversation');
    }
  }, [hasActivity, onSelectedTabChange, selectedTab, tab]);

  if (!hasActivity) {
    return (
      <AiConversation
        nodes={view.nodes}
        status={view.status}
        throughSeq={view.throughSeq}
        {...conversationProps}
      />
    );
  }

  const changeTab = (value: string): void => {
    const next = value === 'activity' ? 'activity' : 'conversation';
    if (selectedTab === undefined) setLocalTab(next);
    onSelectedTabChange?.(next);
  };

  return (
    <Tabs
      value={tab}
      onValueChange={changeTab}
      className="min-h-0 min-w-0 flex-1 gap-0"
      data-through-seq={view.throughSeq ?? undefined}
    >
      <TabsList
        variant="line"
        className="h-8 w-full shrink-0 justify-start gap-3 border-b border-border px-3 @min-[400px]/ai-workspace:px-4 @min-[560px]/ai-workspace:px-5"
        aria-label={t('ai.workspace.views')}
      >
        <TabsTrigger value="conversation" aria-label={t('agent.session.conversation')}>
          <MessageSquareIcon data-icon="inline-start" />
          <span className="@max-[400px]/ai-workspace:sr-only">{t('agent.session.conversation')}</span>
        </TabsTrigger>
        <TabsTrigger value="activity" aria-label={t('agent.session.activity')}>
          <ActivityIcon data-icon="inline-start" />
          <span className="@max-[400px]/ai-workspace:sr-only">{t('agent.session.activity')}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="conversation" className="min-h-0 min-w-0 flex flex-col">
        <AiConversation
          nodes={view.nodes}
          status={view.status}
          throughSeq={view.throughSeq}
          {...conversationProps}
        />
      </TabsContent>
      <TabsContent value="activity" className="min-h-0 min-w-0 flex flex-col">
        {activityContent ?? <AgentActivityView projection={view.activity} />}
      </TabsContent>
    </Tabs>
  );
}

import { BotIcon, CircleAlertIcon, MessageCircleQuestionIcon, RotateCcwIcon, SettingsIcon } from 'lucide-react';
import { AgentApprovalCard } from '@/components/ai/agent-approval-card';
import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { Bubble, Message, MessageScroller } from '@/components/ai/chat-primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PanelEmptyState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import type { LocaleKey } from '@/locales';
import type { AgentRunRecord } from '@/types/agent';

function runOutcomeVariant(run: AgentRunRecord): 'default' | 'warning' | 'destructive' {
  if (run.status === 'completed') return 'default';
  if (run.status === 'partial') return 'warning';
  return 'destructive';
}

export interface AgentRunViewProps {
  readonly conversationId?: string;
  readonly onApprove: Parameters<typeof AgentApprovalCard>[0]['onApprove'];
  readonly onReject: Parameters<typeof AgentApprovalCard>[0]['onReject'];
  readonly onRetry: (requestId: string) => void;
  readonly canRetry: (requestId: string) => boolean;
  readonly onSwitchToAsk: (requestId: string) => void;
  readonly onOpenSettings: () => void;
}

export function AgentRunView({
  conversationId,
  onApprove,
  onReject,
  onRetry,
  canRetry,
  onSwitchToAsk,
  onOpenSettings,
}: AgentRunViewProps): React.ReactNode {
  const { t } = useI18n();
  const allMessages = useAgentStore((state) => state.messages);
  const runs = useAgentStore((state) => state.runs);
  const tools = useAgentStore((state) => state.tools);
  const messages = conversationId ? allMessages.filter((message) => message.conversationId === conversationId) : allMessages;
  const latestMessage = messages[messages.length - 1];
  const latestRun = latestMessage ? runs[latestMessage.requestId] : undefined;
  const followKey = messages.map((message) => `${message.id}:${message.content.length}:${message.toolCallIds.length}`).join('|');

  if (!latestRun || messages.length === 0) {
    return (
      <div className="min-h-0 flex-1">
        <PanelEmptyState icon={<BotIcon />} title={t('agent.emptyTitle')} description={t('agent.emptyDescription')} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScroller className="flex-1" contentClassName="pt-2" followKey={followKey} ariaLabel={t('agent.conversation')}>
        {messages.map((message) => {
          const run = runs[message.requestId];
          if (!run) return null;
          return (
            <Message key={message.id} role={message.role}>
              <Bubble role={message.role}>
                {message.role === 'user' ? (
                  message.content
                ) : (
                  <>
                    {message.content && (
                      <AssistantMessageContent
                        content={message.content}
                        streaming={message.status === 'streaming'}
                        showCodeBlockActions={!run.fallback}
                      />
                    )}
                    {!message.content && message.toolCallIds.length === 0 && message.status === 'streaming' && (
                      <span className="shimmer text-muted-foreground">{t(`agent.phase.${run.phase}` as LocaleKey)}</span>
                    )}
                    {message.toolCallIds.map((callId) => {
                      const snapshot = tools[agentToolKey(message.requestId, callId)];
                      if (!snapshot) return null;
                      return (
                        <AgentApprovalCard
                          key={callId}
                          snapshot={snapshot}
                          targetTitle={run.targetTitle}
                          onApprove={onApprove}
                          onReject={onReject}
                          retryAllowed={canRetry(message.requestId)}
                          onRetry={() => onRetry(message.requestId)}
                        />
                      );
                    })}
                    {run.fallback && (
                      <Alert variant="warning" className="mt-2">
                        <MessageCircleQuestionIcon />
                        <AlertTitle>{t('agent.fallback.title')}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-1.5">
                          <span>{t(`agent.fallback.${run.fallback.reason}` as LocaleKey)}</span>
                          <div>
                            <Button variant="secondary" size="xs" onClick={() => onSwitchToAsk(run.requestId)}>
                              <MessageCircleQuestionIcon data-icon="inline-start" />
                              {t('agent.fallback.switchToAsk')}
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                )}
              </Bubble>
            </Message>
          );
        })}
      </MessageScroller>

      {latestRun.status !== 'running' && latestRun.status !== 'completed' && (
        <Alert variant={runOutcomeVariant(latestRun)} className="mx-3 mb-2 w-auto shrink-0">
          <CircleAlertIcon />
          <AlertTitle>{t(`agent.phase.${latestRun.phase}` as LocaleKey)}</AlertTitle>
          <AlertDescription className="flex flex-col gap-1.5">
            <span>
              {latestRun.error ?? (latestRun.stepLimitReached ? t('agent.recovery.stepLimit') : t('agent.recovery.description'))}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {canRetry(latestRun.requestId) && (
                <Button variant="secondary" size="xs" onClick={() => onRetry(latestRun.requestId)}>
                  <RotateCcwIcon data-icon="inline-start" />
                  {t('agent.tool.retryTask')}
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={onOpenSettings}>
                <SettingsIcon data-icon="inline-start" />
                {t('ai.reviewSettings')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

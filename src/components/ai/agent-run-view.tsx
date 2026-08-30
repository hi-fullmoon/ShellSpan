import {
  BotIcon,
  CircleAlertIcon,
  LockKeyholeIcon,
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { AgentApprovalCard } from '@/components/ai/agent-approval-card';
import { AssistantMessageContent } from '@/components/ai/assistant-message-content';
import { Bubble, Message, MessageScroller } from '@/components/ai/chat-primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { useTerminalStore } from '@/stores/terminalStore';
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
  readonly onStop: (requestId: string) => void;
  readonly onRetry: (requestId: string) => void;
  readonly canRetry: (requestId: string) => boolean;
  readonly onSwitchToAsk: (requestId: string) => void;
  readonly onOpenSettings: () => void;
}

export function AgentRunView({
  conversationId,
  onApprove,
  onReject,
  onStop,
  onRetry,
  canRetry,
  onSwitchToAsk,
  onOpenSettings,
}: AgentRunViewProps): React.ReactNode {
  const { t } = useI18n();
  const allMessages = useAgentStore((state) => state.messages);
  const runs = useAgentStore((state) => state.runs);
  const tools = useAgentStore((state) => state.tools);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const messages = conversationId
    ? allMessages.filter((message) => message.conversationId === conversationId)
    : allMessages;
  const latestMessage = messages[messages.length - 1];
  const latestRun = latestMessage ? runs[latestMessage.requestId] : undefined;
  const targetChanged = Boolean(
    latestRun && activeSessionId && latestRun.target.sessionId !== activeSessionId,
  );
  const followKey = messages.map((message) => (
    `${message.id}:${message.content.length}:${message.toolCallIds.length}`
  )).join('|');

  if (!latestRun || messages.length === 0) {
    return (
      <div className="min-h-0 flex-1">
        <PanelEmptyState
          icon={<BotIcon />}
          title={t('agent.emptyTitle')}
          description={t('agent.emptyDescription')}
        />
      </div>
    );
  }

  const phaseLabel = t(`agent.phase.${latestRun.phase}` as LocaleKey);
  const outcomeLabel = t(`agent.outcome.${latestRun.status}` as LocaleKey);
  const statusLabel = latestRun.status === 'running' ? phaseLabel : outcomeLabel;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert
        variant={targetChanged ? 'warning' : 'default'}
        className="mx-3 mt-2 w-auto shrink-0 py-1.5"
        data-testid="agent-target-binding"
      >
        <LockKeyholeIcon />
        <AlertTitle className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {targetChanged ? t('agent.target.changedTab') : t('agent.target.bound')}
          </span>
          <Badge
            variant={latestRun.status === 'running' ? 'secondary' : 'outline'}
            size="sm"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {latestRun.status === 'running'
              ? <Spinner data-icon="inline-start" size={12} />
              : latestRun.status === 'completed'
                ? <ShieldCheckIcon data-icon="inline-start" />
                : <CircleAlertIcon data-icon="inline-start" />}
            {statusLabel}
          </Badge>
        </AlertTitle>
        <AlertDescription className="flex min-w-0 items-center gap-2">
          {latestRun.targetTitle !== latestRun.target.host && (
            <span className="shrink-0">{latestRun.targetTitle}</span>
          )}
          <code
            className="min-w-0 flex-1 truncate"
            title={`${latestRun.target.username}@${latestRun.target.host}:${latestRun.target.port} · ${latestRun.target.sessionId}`}
          >
            {latestRun.target.username}@{latestRun.target.host}:{latestRun.target.port}
            {' · '}{latestRun.target.sessionId}
          </code>
          {targetChanged && (
            <span className="shrink-0">{t('agent.target.changedTabDescription')}</span>
          )}
        </AlertDescription>
      </Alert>

      <MessageScroller
        className="flex-1"
        contentClassName="pt-2"
        followKey={followKey}
        ariaLabel={t('agent.conversation')}
      >
        {messages.map((message) => {
          const run = runs[message.requestId];
          if (!run) return null;
          return (
            <Message key={message.id} role={message.role}>
              <Bubble role={message.role}>
                {message.role === 'user' ? message.content : (
                  <>
                    {message.content && (
                      <AssistantMessageContent
                        content={message.content}
                        streaming={message.status === 'streaming'}
                        showCodeBlockActions={!run.fallback}
                      />
                    )}
                    {!message.content && message.toolCallIds.length === 0 && message.status === 'streaming' && (
                      <span className="shimmer text-muted-foreground">
                        {t(`agent.phase.${run.phase}` as LocaleKey)}
                      </span>
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
                          onStop={run.status === 'running'
                            ? () => onStop(message.requestId)
                            : undefined}
                          retryAllowed={canRetry(message.requestId)}
                          onRetry={() => onRetry(message.requestId)}
                        />
                      );
                    })}
                    {run.fallback && (
                      <Alert variant="warning" className="mt-2">
                        <MessageCircleQuestionIcon />
                        <AlertTitle>{t('agent.fallback.title')}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-2">
                          <p>{t(`agent.fallback.${run.fallback.reason}` as LocaleKey)}</p>
                          <div>
                            <Button
                              variant="secondary"
                              size="xs"
                              onClick={() => onSwitchToAsk(run.requestId)}
                            >
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
          <AlertDescription className="flex flex-col gap-2">
            <p>
              {latestRun.error
                ?? (latestRun.stepLimitReached
                  ? t('agent.recovery.stepLimit')
                  : t('agent.recovery.description'))}
            </p>
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

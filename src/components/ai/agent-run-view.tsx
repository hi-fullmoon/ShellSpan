import {
  BotIcon,
  CircleAlertIcon,
  LockKeyholeIcon,
  RotateCcwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
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
  readonly onApprove: Parameters<typeof AgentApprovalCard>[0]['onApprove'];
  readonly onReject: Parameters<typeof AgentApprovalCard>[0]['onReject'];
  readonly onStop: (requestId: string) => void;
  readonly onRetry: (requestId: string) => void;
  readonly canRetry: (requestId: string) => boolean;
  readonly onSwitchToCommand: () => void;
  readonly onOpenSettings: () => void;
}

export function AgentRunView({
  onApprove,
  onReject,
  onStop,
  onRetry,
  canRetry,
  onSwitchToCommand,
  onOpenSettings,
}: AgentRunViewProps): React.ReactNode {
  const { t } = useI18n();
  const messages = useAgentStore((state) => state.messages);
  const runs = useAgentStore((state) => state.runs);
  const tools = useAgentStore((state) => state.tools);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert
        variant={targetChanged ? 'warning' : 'default'}
        className="mx-3 mt-3 w-auto shrink-0"
        data-testid="agent-target-binding"
      >
        <LockKeyholeIcon />
        <AlertTitle>
          {targetChanged ? t('agent.target.changedTab') : t('agent.target.bound')}
        </AlertTitle>
        <AlertDescription className="flex min-w-0 flex-col gap-1">
          <span>{latestRun.targetTitle}</span>
          <code className="break-all">
            {latestRun.target.username}@{latestRun.target.host}:{latestRun.target.port}
            {' · '}{latestRun.target.sessionId}
          </code>
          {targetChanged && <span>{t('agent.target.changedTabDescription')}</span>}
        </AlertDescription>
      </Alert>

      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {latestRun.status === 'running'
          ? <Spinner size={14} />
          : latestRun.status === 'completed'
            ? <ShieldCheckIcon className="size-3.5" />
            : <CircleAlertIcon className="size-3.5" />}
        <span className="text-xs text-muted-foreground">
          {t(`agent.phase.${latestRun.phase}` as LocaleKey)}
        </span>
        <Badge variant={latestRun.status === 'running' ? 'secondary' : 'outline'} size="sm">
          {t(`agent.outcome.${latestRun.status}` as LocaleKey)}
        </Badge>
      </div>

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
                        <SquareTerminalIcon />
                        <AlertTitle>{t('agent.fallback.title')}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-2">
                          <p>{t(`agent.fallback.${run.fallback.reason}` as LocaleKey)}</p>
                          <div>
                            <Button variant="secondary" size="xs" onClick={onSwitchToCommand}>
                              <SquareTerminalIcon data-icon="inline-start" />
                              {t('agent.fallback.switchToCommand')}
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

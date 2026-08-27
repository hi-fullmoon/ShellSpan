import { CircleAlertIcon, LockKeyholeIcon, ShieldAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type { AgentAcceptedMessageV1 } from '@/stores/agentStore';
import type { AgentEventTypeV1, AgentRunSnapshotV1 } from '@/types/agent';
import { Bubble, Marker, Message, MessageScroller } from '../chat-primitives';
import { AgentEvidence } from './agent-evidence';
import { AgentPlan } from './agent-plan';
import { AgentReport } from './agent-report';
import { AgentToolCard } from './agent-tool-card';

export function AgentTimeline({
  snapshot,
  acceptedMessages,
  currentProfileId,
  projectionError,
  lastEventType,
  onEvidenceNavigate,
}: {
  snapshot: AgentRunSnapshotV1;
  acceptedMessages: AgentAcceptedMessageV1[];
  currentProfileId?: string;
  projectionError?: string;
  lastEventType?: AgentEventTypeV1;
  onEvidenceNavigate: (evidenceId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const targetChanged = Boolean(
    currentProfileId && currentProfileId !== snapshot.target.profileId,
  );
  const budgetExhausted = snapshot.budgets.usage.modelTurnsUsed
    >= snapshot.budgets.policy.maxModelTurns
    || snapshot.budgets.usage.toolCallsUsed >= snapshot.budgets.policy.maxToolCalls;

  return (
    <MessageScroller
      className="flex-1"
      contentClassName="gap-3 px-3 py-3"
      followKey={`${snapshot.runId}:${snapshot.lastSequence}:${acceptedMessages.length}:${snapshot.state}`}
      ariaLabel={t('ai.dynamicAgent.title')}
    >
      <Message role="user">
        <Bubble role="user">{snapshot.goal}</Bubble>
      </Message>

      {acceptedMessages.map((message) => (
        <Message key={message.id} role="user">
          <Bubble role="user">
            <span className="block text-xs text-muted-foreground">
              {t(message.kind === 'answer'
                ? 'ai.dynamicAgent.message.answer'
                : 'ai.dynamicAgent.message.steering')}
            </span>
            {message.text}
          </Bubble>
        </Message>
      ))}

      <Marker>
        <span className="flex flex-wrap items-center justify-center gap-1.5">
          <Badge variant="secondary">{t('ai.dynamicAgent.readOnly')}</Badge>
          <span>{t(`ai.dynamicAgent.state.${snapshot.state}` as LocaleKey)}</span>
          {lastEventType ? <span>· {lastEventType}</span> : null}
        </span>
      </Marker>

      {targetChanged && (
        <Alert>
          <LockKeyholeIcon />
          <AlertTitle>{t('ai.dynamicAgent.frozenTargetHint')}</AlertTitle>
          <AlertDescription>
            {snapshot.target.profileLabel} · {snapshot.target.username}@{snapshot.target.host}:{snapshot.target.port}
          </AlertDescription>
        </Alert>
      )}

      {projectionError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('ai.dynamicAgent.projectionFailed')}</AlertTitle>
          <AlertDescription>{projectionError}</AlertDescription>
        </Alert>
      )}

      {snapshot.error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {snapshot.error.category === 'providerIncompatible'
              ? t('ai.dynamicAgent.providerIncompatibleTitle')
              : t(`ai.dynamicAgent.state.${snapshot.state}` as LocaleKey)}
          </AlertTitle>
          <AlertDescription>
            {snapshot.error.message}
            {snapshot.error.suggestion ? ` ${snapshot.error.suggestion}` : ''}
          </AlertDescription>
        </Alert>
      )}

      {budgetExhausted && (
        <Marker>{t('ai.dynamicAgent.budget.exhausted')}</Marker>
      )}

      <AgentPlan plan={snapshot.plan} />

      {snapshot.toolCalls.map((toolCall) => (
        <AgentToolCard
          key={toolCall.toolCallId}
          toolCall={toolCall}
          onEvidenceNavigate={onEvidenceNavigate}
        />
      ))}

      <AgentEvidence runId={snapshot.runId} evidence={snapshot.evidence} />

      {snapshot.report && (
        <AgentReport report={snapshot.report} onEvidenceNavigate={onEvidenceNavigate} />
      )}

      <Alert>
        <ShieldAlertIcon />
        <AlertTitle>{t('ai.dynamicAgent.stopLimitTitle')}</AlertTitle>
        <AlertDescription>{t('ai.dynamicAgent.stopLimitDescription')}</AlertDescription>
      </Alert>
    </MessageScroller>
  );
}

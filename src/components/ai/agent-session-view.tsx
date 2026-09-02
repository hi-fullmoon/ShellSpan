import { CircleAlertIcon, RotateCcwIcon, SettingsIcon } from 'lucide-react';

import { AgentActivityView } from '@/components/ai/agent-activity-view';
import { AgentApprovalCard } from '@/components/ai/agent-approval-card';
import { AgentConversationView } from '@/components/ai/agent-conversation-view';
import { AgentToolRow } from '@/components/ai/agent-tool-row';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import {
  agentToolApprovalSnapshot,
} from '@/lib/agent-tool-approval';
import type {
  AgentConversationToolItem,
  AgentSessionProjection,
  AgentSessionRuntimeStatus,
  AgentRuntimeToolDecisionInput,
} from '@/types/agent-session';

function statusTitle(
  status: AgentSessionRuntimeStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (status) {
    case 'cancelled': return t('agent.outcome.cancelled');
    case 'failed': return t('agent.outcome.failed');
    case 'completed': return t('agent.outcome.completed');
    case 'running': return t('agent.outcome.running');
    case 'waiting': return t('agent.session.status.waiting');
    case 'idle': return t('agent.session.status.idle');
  }
}

export interface AgentSessionViewProps {
  readonly projection: AgentSessionProjection;
  readonly onApproveRuntime?: (reference: AgentRuntimeToolDecisionInput) => void;
  readonly onRejectRuntime?: (reference: AgentRuntimeToolDecisionInput) => void;
  readonly onRetry?: (requestId: string) => void;
  readonly canRetry?: (requestId: string) => boolean;
  readonly onOpenSettings?: () => void;
}

export function AgentSessionView({
  projection,
  onApproveRuntime,
  onRejectRuntime,
  onRetry,
  canRetry,
  onOpenSettings,
}: AgentSessionViewProps): React.ReactNode {
  const { t } = useI18n();
  const requestId = projection.latestRequestId;
  const retryable = Boolean(
    requestId && onRetry && canRetry?.(requestId),
  );
  const renderTool = (tool: AgentConversationToolItem): React.ReactNode => {
    const snapshot = agentToolApprovalSnapshot(projection.sessionId, tool, projection.permissionMode);
    if (!snapshot || !onApproveRuntime || !onRejectRuntime) {
      return <AgentToolRow tool={tool} />;
    }
    return (
      <AgentApprovalCard
        snapshot={snapshot}
        targetTitle={tool.target?.label}
        onApprove={onApproveRuntime}
        onReject={onRejectRuntime}
        retryAllowed={requestId ? canRetry?.(requestId) : false}
        onRetry={requestId && onRetry ? () => onRetry(requestId) : undefined}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="agent-session-view">
      {(projection.status === 'failed' || projection.status === 'cancelled') && (
        <Alert
          variant={projection.status === 'failed' ? 'destructive' : 'warning'}
          size="sm"
          className="mx-3 mt-3 w-auto shrink-0"
        >
          <CircleAlertIcon />
          <AlertTitle>{statusTitle(projection.status, t)}</AlertTitle>
          <AlertDescription className="flex flex-col gap-1.5">
            {projection.statusReason && <span>{projection.statusReason}</span>}
            {(retryable || onOpenSettings) && (
              <div className="flex flex-wrap gap-1.5">
                {retryable && requestId && onRetry && (
                  <Button variant="secondary" size="xs" onClick={() => onRetry(requestId)}>
                    <RotateCcwIcon data-icon="inline-start" />
                    {t('agent.tool.retryTask')}
                  </Button>
                )}
                {onOpenSettings && (
                  <Button variant="ghost" size="xs" onClick={onOpenSettings}>
                    <SettingsIcon data-icon="inline-start" />
                    {t('ai.reviewSettings')}
                  </Button>
                )}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="conversation" className="min-h-0 flex-1">
        <TabsList variant="line" className="mx-3 mt-2 shrink-0">
          <TabsTrigger value="conversation">{t('agent.session.conversation')}</TabsTrigger>
          <TabsTrigger value="activity">{t('agent.session.activity')}</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="min-h-0 flex flex-col">
          <AgentConversationView projection={projection.conversation} renderTool={renderTool} />
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex flex-col">
          <AgentActivityView projection={projection.activity} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

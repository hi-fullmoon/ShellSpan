import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { openTerminalTask, terminalTaskWorkspace } from './agent-terminal-task-navigation';

export function AgentTerminalOccupancyNotice({ sessionId, agentSessionId }: {
  sessionId: string | null;
  agentSessionId?: string | null;
}) {
  const { t } = useI18n();
  const { error } = useToast();
  const lease = useSyncExternalStore(agentTerminalLeaseState.subscribe, () => agentTerminalLeaseState.get(sessionId));
  const ownTask = lease?.agentSessionId === agentSessionId;
  const [conflictSession, setConflictSession] = useState<string | null>(null);
  useEffect(() => {
    if (lease) setConflictSession(ownTask ? null : sessionId);
  }, [lease, ownTask, sessionId]);
  if (!lease) return conflictSession && conflictSession === sessionId
    ? <Alert variant="info" size="sm" role="status" data-slot="terminal-occupancy-released"><AlertDescription>{t('terminal.occupancy.released')}</AlertDescription></Alert>
    : null;
  return <Alert variant={ownTask ? 'info' : 'warning'} size="sm" role="status" data-slot="terminal-occupancy-notice">
    <AlertDescription className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="min-w-0 flex-1 basis-48">{t(ownTask ? 'terminal.occupancy.own' : 'terminal.occupancy.other', {
        workspace: t(terminalTaskWorkspace(lease) === 'focus' ? 'terminal.occupancy.focus' : 'terminal.occupancy.terminal'),
      })} {t('terminal.occupancy.lockHint')}</span>
      <Button variant="ghost" size="xs" onClick={() => {
        if (!openTerminalTask(lease)) error(t('terminal.occupancy.navigationBlocked'));
      }}>{t('terminal.occupancy.viewTask')}</Button>
      <Button variant="outline" size="xs" disabled={lease.takeoverRequested} onClick={lease.requestTakeover}>
        {t(lease.takeoverRequested ? 'terminal.agentLease.takingOver' : 'terminal.agentLease.takeover')}
      </Button>
    </AlertDescription>
  </Alert>;
}

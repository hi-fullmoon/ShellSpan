import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { RadioTowerIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { useFocusStore } from '@/stores/focusStore';
import { canReceiveTerminalBroadcast, useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { terminalInputReadiness } from './terminal-input-readiness';
import { getTerminalGroups } from './terminal-split';

function currentEligibleBroadcastSelection(): Set<string> {
  const current = useTerminalBroadcastStore.getState();
  const eligibleIds = new Set(
    useTerminalStore.getState().sessions
      .filter((session) => session.status === 'connected' && !session.pendingConnection && canReceiveTerminalBroadcast(session))
      .map((session) => session.sessionId),
  );
  return new Set([...current.sessionIds].filter((id) => eligibleIds.has(id)));
}

export function TerminalBroadcastControls({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { mode, sessionIds, configure } = useTerminalBroadcastStore();
  const sessions = useTerminalStore((state) => state.sessions);
  const split = useTerminalStore((state) => state.workspaceSplit);
  const focusHidden = useFocusStore((state) => state.enabled && !state.terminalOpen);
  const effectiveVisible = visible && !focusHidden;
  const connected = sessions.filter((session) => session.status === 'connected' && !session.pendingConnection);
  const protectionSnapshot = () => connected
    .map((session) => `${session.sessionId}:${terminalInputReadiness.isPreparing(session.sessionId) ? 1 : 0}:${agentTerminalLeaseState.get(session.sessionId) ? 1 : 0}`)
    .join('|');
  useSyncExternalStore(terminalInputReadiness.subscribe, protectionSnapshot);
  useSyncExternalStore(agentTerminalLeaseState.subscribe, protectionSnapshot);
  const admitted = sessions.filter((session) => sessionIds.has(session.sessionId)
    && canReceiveTerminalBroadcast(session)).length;
  const eligibleSessions = connected.filter((session) => canReceiveTerminalBroadcast(session));
  const paneIds = split ? getTerminalGroups(split).map((group) => group.activeSessionId) : [];
  const eligiblePaneTargetCount = eligibleSessions.filter((session) => paneIds.includes(session.sessionId)).length;
  const eligibleSelectionCount = eligibleSessions.filter((session) => selected.has(session.sessionId)).length;

  useEffect(() => {
    if (!effectiveVisible) {
      setOpen(false);
      return;
    }
    const request = () => {
      setSelected(currentEligibleBroadcastSelection());
      setOpen(true);
    };
    document.addEventListener('shellspan:configure-terminal-broadcast', request);
    return () => document.removeEventListener('shellspan:configure-terminal-broadcast', request);
  }, [effectiveVisible]);

  const skipped = Math.max(0, sessionIds.size - admitted);

  return <>
    {mode !== 'off' && <Alert variant="warning" size="sm" className="shrink-0 rounded-none border-x-0 border-t-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
        <AlertDescription className="flex min-w-0 items-start gap-1">
          <RadioTowerIcon aria-hidden="true" className="h-lh w-3.5 shrink-0 text-app-warning" />
          <span className="min-w-0">
            {skipped > 0
              ? t('terminal.broadcast.active', { count: admitted, skipped })
              : t('terminal.broadcast.activeAll', { count: admitted })}
          </span>
        </AlertDescription>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => {
            setSelected(currentEligibleBroadcastSelection());
            setOpen(true);
          }}>{t('terminal.broadcast.configure')}</Button>
          <Button variant="outline" size="xs" onClick={() => configure('off')}>{t('terminal.broadcast.stop')}</Button>
        </div>
      </div>
    </Alert>}
    <Dialog open={open} onOpenChange={setOpen}>
      <CompactDialogContent className="max-w-md">
        <CompactDialogHeader title={t('terminal.broadcast.configure')} description={t('terminal.broadcast.description')} />
        <CompactDialogBody className="gap-2">
          {connected.length === 0 ? (
            <EmptyState size="sm" icon={<RadioTowerIcon className="size-5" />} title={t('terminal.broadcast.empty')} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  {mode !== 'off' && (
                    <Badge variant="secondary" size="sm">
                      {t(mode === 'splitGroup' ? 'terminal.broadcast.mode.splitGroup' : 'terminal.broadcast.mode.custom')}
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="xs"
                    disabled={eligibleSessions.length === 0 || eligibleSelectionCount === eligibleSessions.length}
                    onClick={() => setSelected(new Set(eligibleSessions.map((session) => session.sessionId)))}>
                    {t('terminal.broadcast.selectAll')}
                  </Button>
                  <Button type="button" variant="ghost" size="xs" disabled={eligibleSelectionCount === 0}
                    onClick={() => setSelected(new Set())}>
                    {t('terminal.broadcast.clearSelection')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {connected.map((session, index) => {
                  const isRemote = !(session.host === 'local' && session.port === 0);
                  const eligible = canReceiveTerminalBroadcast(session);
                  return (
                    <label key={session.sessionId} htmlFor={`${id}-${index}`}
                      className={cn(
                        'flex cursor-default items-start gap-2.5 rounded-lg border border-border px-3 py-2 transition-colors',
                        eligible ? 'hover:bg-accent' : 'opacity-65',
                      )}>
                      <Checkbox id={`${id}-${index}`} aria-label={session.title} className="mt-0.5"
                        disabled={!eligible}
                        checked={eligible && selected.has(session.sessionId)}
                        onCheckedChange={(checked) => {
                          if (!eligible) return;
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (checked) next.add(session.sessionId);
                            else next.delete(session.sessionId);
                            return next;
                          });
                        }} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium break-all text-foreground">{session.title}</span>
                          {!eligible && (
                            <Badge variant="outline" size="sm">{t('terminal.broadcast.protectedBadge')}</Badge>
                          )}
                        </span>
                        {isRemote && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {session.username}@{session.host}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="outline" size="sm" disabled={eligiblePaneTargetCount < 2} onClick={() => {
            configure('splitGroup');
            setOpen(false);
          }}>{t('terminal.broadcast.usePanes')}</Button>
          <Button size="sm" disabled={eligibleSelectionCount < 2} onClick={() => {
            configure(
              'custom',
              eligibleSessions
                .filter((session) => selected.has(session.sessionId))
                .map((session) => session.sessionId),
            );
            setOpen(false);
          }}>{t('terminal.broadcast.useSelected')}</Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  </>;
}

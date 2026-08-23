import {
  ActivityIcon,
  BotIcon,
  CableIcon,
  FolderIcon,
  TerminalIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import { buildHostOverview } from '@/lib/host-overview';
import { useAgentStore } from '@/stores/agentStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useTransferStore } from '@/stores/transferStore';
import type { ConnectionProfile } from '@/types';
import { usePortForwardStore } from '@/stores/portForwardStore';

interface HostOverviewDialogProps {
  profile?: ConnectionProfile;
  onClose: () => void;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-app-border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

export function HostOverviewDialog({ profile, onClose }: HostOverviewDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const sftpConnections = useSftpStore((state) => state.connections);
  const transfers = useTransferStore((state) => state.operations);
  const disconnectEvents = useMonitorStore((state) => state.disconnectEvents);
  const agentRun = useAgentStore((state) => state.run);
  const portForwards = usePortForwardStore((state) => state.runtimes);
  const snapshot = useMemo(() => profile
    ? buildHostOverview(
        profile,
        sessions,
        sftpConnections,
        transfers,
        disconnectEvents,
        portForwards,
        agentRun,
      )
    : undefined, [agentRun, disconnectEvents, portForwards, profile, sessions, sftpConnections, transfers]);

  return (
    <Dialog open={Boolean(profile)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('hostOverview.title')}</DialogTitle>
          <DialogDescription>
            {profile ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}` : ''}
          </DialogDescription>
        </DialogHeader>

        {snapshot && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <MetricCard
                icon={TerminalIcon}
                label={t('hostOverview.terminals')}
                value={snapshot.terminalTotal}
                detail={t('hostOverview.terminalsDetail', {
                  connected: snapshot.terminals.connected,
                  error: snapshot.terminals.error,
                })}
              />
              <MetricCard
                icon={FolderIcon}
                label={t('hostOverview.sftp')}
                value={snapshot.sftpRemotePanes}
                detail={t('hostOverview.sftpDetail', { tabs: snapshot.sftpTabs })}
              />
              <MetricCard
                icon={ActivityIcon}
                label={t('hostOverview.transfers')}
                value={snapshot.activeTransfers}
                detail={t('hostOverview.transfersDetail', { failed: snapshot.failedTransfers })}
              />
              <MetricCard
                icon={CableIcon}
                label={t('hostOverview.forwards')}
                value={snapshot.activePortForwards}
                detail={t('hostOverview.forwardsDetail', { failed: snapshot.failedPortForwards })}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-app-border p-3 text-sm">
              <BotIcon className="size-4 text-muted-foreground" />
              <span>{t('hostOverview.diagnostic')}</span>
              <Badge variant="outline">
                {snapshot.diagnosticPhase ?? t('hostOverview.none')}
              </Badge>
            </div>

            {snapshot.latestError && (
              <Alert variant="destructive">
                <ActivityIcon />
                <AlertTitle>{t('hostOverview.latestError')}</AlertTitle>
                <AlertDescription>{snapshot.latestError}</AlertDescription>
              </Alert>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

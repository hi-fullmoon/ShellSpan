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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
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
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Icon />
          {label}
        </CardDescription>
        <CardTitle className="text-xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

export function HostOverviewDialog({ profile, onClose }: HostOverviewDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const sftpConnections = useSftpStore((state) => state.connections);
  const pathOccupancyRevision = useTransferStore(
    (state) => state.pathOccupancyRevision,
  );
  const transfers = useMemo(
    () => useTransferStore.getState().operations,
    [pathOccupancyRevision],
  );
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
      <CompactDialogContent>
        <CompactDialogHeader
          title={t('hostOverview.title')}
          description={profile
            ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`
            : ''}
        />

        {snapshot && (
          <CompactDialogBody className="flex flex-col gap-3">
            <div className="grid shrink-0 grid-cols-2 gap-2">
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

            <Card size="sm" className="shrink-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BotIcon />
                  {t('hostOverview.diagnostic')}
                </CardTitle>
                <CardAction>
                  <Badge variant="outline">
                    {snapshot.diagnosticPhase ?? t('hostOverview.none')}
                  </Badge>
                </CardAction>
              </CardHeader>
            </Card>

            {snapshot.latestError && (
              <Alert variant="destructive" className="shrink-0">
                <ActivityIcon />
                <AlertTitle>{t('hostOverview.latestError')}</AlertTitle>
                <AlertDescription>{snapshot.latestError}</AlertDescription>
              </Alert>
            )}
          </CompactDialogBody>
        )}

        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('common.close')}</Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}

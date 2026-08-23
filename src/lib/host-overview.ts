import type { SftpConnection } from '@/stores/sftpStore';
import type { TerminalSession } from '@/stores/terminalStore';
import type { TransferOperation } from '@/stores/transferStore';
import type { AgentRun } from '@/types/ai';
import type {
  ConnectionProfile,
  DisconnectEvent,
  PortForwardRuntime,
  SessionStatus,
} from '@/types';

export interface HostOverviewSnapshot {
  terminals: Record<SessionStatus, number>;
  terminalTotal: number;
  sftpTabs: number;
  sftpRemotePanes: number;
  activeTransfers: number;
  failedTransfers: number;
  diagnosticPhase?: AgentRun['phase'];
  latestDisconnect?: DisconnectEvent;
  latestError?: string;
  activePortForwards: number;
  failedPortForwards: number;
}

const ACTIVE_TRANSFER_STATUSES = new Set(['pending', 'running', 'cancelling']);
const ACTIVE_PORT_FORWARD_STATUSES = new Set(['starting', 'running', 'stopping']);

export function buildHostOverview(
  profile: ConnectionProfile,
  sessions: TerminalSession[],
  sftpConnections: SftpConnection[],
  transfers: TransferOperation[],
  disconnectEvents: DisconnectEvent[],
  portForwards: PortForwardRuntime[],
  agentRun?: AgentRun,
): HostOverviewSnapshot {
  const hostSessions = sessions.filter((session) => session.profileId === profile.id);
  const terminals: Record<SessionStatus, number> = {
    connecting: 0,
    connected: 0,
    disconnected: 0,
    error: 0,
  };
  for (const session of hostSessions) terminals[session.status] += 1;

  const matchingSftpConnections = sftpConnections.filter((connection) => (
    connection.profileId === profile.id || connection.leftProfileId === profile.id
  ));
  const connectionIds = new Set(matchingSftpConnections.map((connection) => connection.id));
  const hostTransfers = transfers.filter((transfer) => (
    (transfer.ownerId && connectionIds.has(transfer.ownerId))
    || (transfer.connectionId && connectionIds.has(transfer.connectionId))
  ));
  const latestDisconnect = [...disconnectEvents].reverse().find((event) => (
    event.host === profile.host
    && event.port === profile.port
    && event.username === profile.username
  ));
  const failedTransfer = hostTransfers.find((transfer) => transfer.status === 'failed');
  const hostForwards = portForwards.filter((runtime) => runtime.profileId === profile.id);
  const failedForward = hostForwards.find((runtime) => runtime.status === 'failed');
  const diagnosticSessionIds = new Set(hostSessions.map((session) => session.sessionId));

  return {
    terminals,
    terminalTotal: hostSessions.length,
    sftpTabs: matchingSftpConnections.length,
    sftpRemotePanes: matchingSftpConnections.reduce((count, connection) => (
      count
      + (connection.profileId === profile.id ? 1 : 0)
      + (connection.leftProfileId === profile.id ? 1 : 0)
    ), 0),
    activeTransfers: hostTransfers.filter((transfer) => (
      ACTIVE_TRANSFER_STATUSES.has(transfer.status ?? 'running')
    )).length,
    failedTransfers: hostTransfers.filter((transfer) => transfer.status === 'failed').length,
    diagnosticPhase: agentRun && diagnosticSessionIds.has(agentRun.sessionId)
      ? agentRun.phase
      : undefined,
    latestDisconnect,
    latestError: failedForward?.lastError ?? failedTransfer?.error ?? latestDisconnect?.reason,
    activePortForwards: hostForwards.filter((runtime) => (
      ACTIVE_PORT_FORWARD_STATUSES.has(runtime.status)
    )).length,
    failedPortForwards: hostForwards.filter((runtime) => runtime.status === 'failed').length,
  };
}

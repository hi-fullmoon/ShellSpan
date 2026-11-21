import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useAppStore } from '@/stores/appStore';
import { getSftpPaneConnectionKey, getSftpPaneSource, useSftpStore, type SftpConnection, type SftpLocationRequest, type SftpSide } from '@/stores/sftpStore';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile, HostConnectionAction } from '@/types';
import { validateHostQuickAction } from '@/lib/host/host-quick-action-model';
export {
  sanitizeHostQuickActions,
  validateHostQuickAction,
  type HostQuickActionValidationError,
} from '@/lib/host/host-quick-action-model';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function findConnectedTerminalSession(profileId: string): string | undefined {
  const { activeSessionId, sessions } = useTerminalStore.getState();
  const active = sessions.find((session) => (
    session.sessionId === activeSessionId
    && session.profileId === profileId
    && session.status === 'connected'
    && !session.readOnly
  ));
  return active?.sessionId ?? sessions.find((session) => (
    session.profileId === profileId && session.status === 'connected' && !session.readOnly
  ))?.sessionId;
}

/**
 * Inserts editable text into an already connected shell. Newline and carriage
 * return are rejected again at execution time so this path can never execute
 * the command, even if malformed metadata reaches it.
 */
export async function insertHostCommandSnippet(
  profileId: string,
  command: string,
): Promise<'inserted' | 'no-target' | 'invalid'> {
  if (
    !command
    || CONTROL_CHARACTERS.test(command)
    || validateHostQuickAction({
      id: 'execution-check',
      kind: 'command',
      label: 'execution-check',
      command,
    })
  ) return 'invalid';
  const sessionId = findConnectedTerminalSession(profileId);
  if (!sessionId) return 'no-target';
  const controller = terminalRegistry.get(sessionId);
  if (!controller) return 'no-target';
  if (!await controller.writeUserInput(command)) return 'no-target';
  useTerminalStore.getState().setActiveSession(sessionId);
  useAppStore.getState().setActiveSection('terminal');
  return 'inserted';
}

export function findSftpPaneForLocation(
  connections: readonly SftpConnection[],
  profileId: string,
  routeKey: string,
): { connection: SftpConnection; side: SftpSide } | undefined {
  const sides: readonly SftpSide[] = ['remote', 'local'];
  for (const connection of connections) {
    const side = sides.find(candidate => (
      (candidate === 'remote' ? connection.profileId : connection.leftProfileId) === profileId
      && getSftpPaneSource(connection, candidate) === 'remote'
      && !connection.restorePending?.[candidate] && !connection.connectionAttemptIds?.[candidate]
      && routeKey === getSftpPaneConnectionKey(connection, candidate)
    ));
    if (side) return { connection, side };
  }
}

export function openHostPath(
  profile: ConnectionProfile,
  path: string,
  target: 'terminal' | 'sftp',
  sftpSide: 'local' | 'remote' = 'remote',
  locationRequest?: SftpLocationRequest,
): boolean {
  if (target === 'sftp') {
    const state = useSftpStore.getState();
    if (locationRequest) {
      const pane = findSftpPaneForLocation(state.connections, profile.id, locationRequest.routeKey);
      if (pane) {
        const { connection, side } = pane;
        state.setPaneState(connection.id, side, { locationRequest });
        state.setActiveConnection(connection.id);
        useAppStore.getState().setActiveSection('sftp');
        return true;
      }
      if (locationRequest.routeKey !== sshRouteKey(profile)) return false;
    }
    const openConnection = !locationRequest && state.connections.find((connection) => (
      connection.profileId === profile.id || connection.leftProfileId === profile.id
    ));
    if (openConnection) {
      const openSide = openConnection.profileId === profile.id ? 'remote' : 'local';
      state.setActiveConnection(openConnection.id);
      useAppStore.getState().setActiveSection('sftp');
      document.dispatchEvent(new CustomEvent('shellspan:open-sftp-path', {
        detail: { connectionId: openConnection.id, side: openSide, path },
      }));
      return true;
    }
  }
  document.dispatchEvent(new CustomEvent('shellspan:connect-profile', {
    detail: {
      profileId: profile.id,
      target,
      initialDirectory: path,
      sftpSide: target === 'sftp' ? 'remote' : sftpSide,
      ...(locationRequest && { locationRequest }),
    },
  }));
  return true;
}

export function runHostConnectionAction(
  profileId: string,
  action: HostConnectionAction,
): void {
  if (action === 'terminal' || action === 'sftp') {
    document.dispatchEvent(new CustomEvent('shellspan:connect-profile', {
      detail: { profileId, target: action },
    }));
    return;
  }
  useAppStore.getState().setActiveSection('workbench');
  useAppStore.getState().setActiveWorkbenchTab('connections');
  document.dispatchEvent(new CustomEvent('shellspan:open-host-tool', {
    detail: { profileId, tool: action },
  }));
}

import { invokeWriteSession } from '@/lib/tauri';
import { useAppStore } from '@/stores/appStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile, HostConnectionAction } from '@/types';
import { validateHostQuickAction } from '@/lib/host-quick-action-model';
export {
  sanitizeHostQuickActions,
  validateHostQuickAction,
  type HostQuickActionValidationError,
} from '@/lib/host-quick-action-model';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function findConnectedTerminalSession(profileId: string): string | undefined {
  const { activeSessionId, sessions } = useTerminalStore.getState();
  const active = sessions.find((session) => (
    session.sessionId === activeSessionId
    && session.profileId === profileId
    && session.status === 'connected'
  ));
  return active?.sessionId ?? sessions.find((session) => (
    session.profileId === profileId && session.status === 'connected'
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
  useTerminalStore.getState().setActiveSession(sessionId);
  useAppStore.getState().setActiveSection('terminal');
  await invokeWriteSession(sessionId, command);
  return 'inserted';
}

export function openHostPath(
  profile: ConnectionProfile,
  path: string,
  target: 'terminal' | 'sftp',
  sftpSide: 'local' | 'remote' = 'remote',
): void {
  if (target === 'sftp') {
    const state = useSftpStore.getState();
    const openConnection = state.connections.find((connection) => (
      connection.profileId === profile.id || connection.leftProfileId === profile.id
    ));
    if (openConnection) {
      const openSide = openConnection.profileId === profile.id ? 'remote' : 'local';
      state.setActiveConnection(openConnection.id);
      useAppStore.getState().setActiveSection('sftp');
      document.dispatchEvent(new CustomEvent('shellspan:open-sftp-path', {
        detail: { connectionId: openConnection.id, side: openSide, path },
      }));
      return;
    }
  }
  document.dispatchEvent(new CustomEvent('shellspan:connect-profile', {
    detail: {
      profileId: profile.id,
      target,
      initialDirectory: path,
      sftpSide: target === 'sftp' ? 'remote' : sftpSide,
    },
  }));
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

import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  buildSessionCreateRequest,
  invokeCloseSession,
  invokeCreateSession,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { promptForMissingPassword } from '@/lib/passwordPrompt';

const logger = createLogger('reconnect');

export function useReconnectSession(): (sessionId: string) => Promise<void> {
  const getProfile = useProfileStore((state) => state.getProfile);
  const reconnectSession = useTerminalStore((state) => state.reconnectSession);
  const setReconnecting = useTerminalStore((state) => state.setReconnecting);
  const setStatus = useTerminalStore((state) => state.setStatus);

  return async (sessionId: string): Promise<void> => {
    const session = useTerminalStore
      .getState()
      .sessions.find((s) => s.sessionId === sessionId);
    if (!session?.profileId) {
      return;
    }

    const profile = getProfile(session.profileId);
    if (!profile) {
      return;
    }

    const profileWithPassword = await promptForMissingPassword(profile);
    if (!profileWithPassword) {
      logger.info(`Reconnect cancelled by user for session ${sessionId}`);
      return;
    }

    setReconnecting(sessionId, true);
    logger.info(`Reconnecting session ${sessionId} (${profile.host}:${profile.port})`);
    try {
      const summary = await invokeCreateSession(
        buildSessionCreateRequest(profileWithPassword, 120, 30),
      );

      terminalRegistry.rebindSession(sessionId, summary.sessionId);
      reconnectSession(sessionId, summary, profile.id);
      logger.info(`Reconnected session ${sessionId} as session ${summary.sessionId}`);
      invokeCloseSession(sessionId).catch((error) => {
        logger.warn(`Failed to close replaced session ${sessionId}`, error);
      });
    } catch (error) {
      logger.error(`Failed to reconnect session ${sessionId}`, error);
      setStatus(sessionId, {
        sessionId,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

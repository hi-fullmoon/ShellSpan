import { useCallback } from 'react';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  buildSessionCreateRequest,
  invokeCloseSession,
  invokeCreateLocalSession,
  invokeCreateSession,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { promptForMissingPassword } from '@/lib/password-prompt';
import { getLocalizedErrorMessage } from '@/lib/error';

const logger = createLogger('reconnect');

// Sessions with a reconnect in flight (password prompt + session creation);
// a concurrent reconnect for the same session is ignored.
const reconnectInFlight = new Set<string>();

export function useReconnectSession(): (sessionId: string) => Promise<void> {
  return useCallback(async (sessionId: string): Promise<void> => {
    if (reconnectInFlight.has(sessionId)) {
      logger.info(`Reconnect already in flight for session ${sessionId}, ignoring`);
      return;
    }

    const session = useTerminalStore
      .getState()
      .sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      return;
    }

    reconnectInFlight.add(sessionId);
    try {
      const { setReconnecting, setStatus, reconnectSession } = useTerminalStore.getState();

      // Sessions without a profile are local shells; recreate them directly.
      if (!session.profileId) {
        setReconnecting(sessionId, true);
        logger.info(`Reconnecting local session ${sessionId}`);
        try {
          const summary = await invokeCreateLocalSession(120, 30);

          terminalRegistry.rebindSession(sessionId, summary.sessionId);
          reconnectSession(sessionId, summary);
          logger.info(`Reconnected local session ${sessionId} as session ${summary.sessionId}`);
          invokeCloseSession(sessionId).catch((error) => {
            logger.warn(`Failed to close replaced session ${sessionId}`, error);
          });
        } catch (error) {
          logger.error(`Failed to reconnect local session ${sessionId}`, error);
          setStatus(sessionId, {
            sessionId,
            status: 'error',
            message: getLocalizedErrorMessage(error),
          });
        }
        return;
      }

      const profile = useProfileStore.getState().getProfile(session.profileId);
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
          message: getLocalizedErrorMessage(error),
        });
      }
    } finally {
      reconnectInFlight.delete(sessionId);
    }
  }, []);
}

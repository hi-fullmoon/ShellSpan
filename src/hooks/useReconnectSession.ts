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
import { getErrorMessage, getLocalizedErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  getMissingKeychainKeyTarget,
  promptForMissingKeychainKey,
} from '@/lib/keychain-key-prompt';
import { usePortForwardStore } from '@/stores/portForwardStore';

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
      // Create the replacement session at the terminal's current size so the
      // follow-up resize is a no-op; otherwise the SIGWINCH makes the remote
      // shell redraw its prompt, showing duplicated prompt lines.
      const controller = terminalRegistry.get(sessionId);
      const cols = controller?.terminal.cols ?? 120;
      const rows = controller?.terminal.rows ?? 30;

      // Sessions without a profile are local shells; recreate them directly.
      if (!session.profileId) {
        setReconnecting(sessionId, true);
        logger.info(`Reconnecting local session ${sessionId}`);
        try {
          const summary = await invokeCreateLocalSession(cols, rows);

          if (!useTerminalStore.getState().sessions.some((item) => item.sessionId === sessionId)) {
            logger.info(`Discarding replacement local session ${summary.sessionId}; source ${sessionId} was closed`);
            await invokeCloseSession(summary.sessionId).catch((error) => {
              logger.warn(`Failed to close orphaned replacement session ${summary.sessionId}`, error);
            });
            return;
          }
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

      const profileWithSavedSecrets = await useProfileStore
        .getState()
        .ensurePassword(profile);
      const profileWithPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!profileWithPassword) {
        logger.info(`Reconnect cancelled by user for session ${sessionId}`);
        return;
      }

      const profileWithKey = await ensureKeychainKeyForProfile(profileWithPassword);
      if (!profileWithKey) {
        logger.info(`Reconnect cancelled by user for session ${sessionId}`);
        return;
      }

      const preparedProfile = profileWithKey;

      setReconnecting(sessionId, true);
      logger.info(`Reconnecting session ${sessionId} (${profile.host}:${profile.port})`);
      const replaceSession = async (
        summary: Awaited<ReturnType<typeof invokeCreateSession>>,
      ): Promise<void> => {
        if (!useTerminalStore.getState().sessions.some((item) => item.sessionId === sessionId)) {
          logger.info(`Discarding replacement session ${summary.sessionId}; source ${sessionId} was closed`);
          await invokeCloseSession(summary.sessionId).catch((error) => {
            logger.warn(`Failed to close orphaned replacement session ${summary.sessionId}`, error);
          });
          return;
        }
        terminalRegistry.rebindSession(sessionId, summary.sessionId);
        reconnectSession(sessionId, summary, profile.id);
        void usePortForwardStore
          .getState()
          .startAutoForOwner(preparedProfile, `terminal:${summary.sessionId}`);
        logger.info(`Reconnected session ${sessionId} as session ${summary.sessionId}`);
        invokeCloseSession(sessionId).catch((error) => {
          logger.warn(`Failed to close replaced session ${sessionId}`, error);
        });
      };

      try {
        const summary = await invokeCreateSession(
          buildSessionCreateRequest(preparedProfile, cols, rows),
        );
        await replaceSession(summary);
      } catch (error) {
        const missingKeyTarget = getMissingKeychainKeyTarget(
          preparedProfile,
          getErrorMessage(error),
        );
        if (missingKeyTarget) {
          const recoveredProfile = await promptForMissingKeychainKey(
            preparedProfile,
            missingKeyTarget,
          );
          if (!recoveredProfile) {
            logger.info(`Reconnect cancelled by user for session ${sessionId}`);
            return;
          }
          try {
            const summary = await invokeCreateSession(
              buildSessionCreateRequest(recoveredProfile, cols, rows),
            );
            await replaceSession(summary);
            return;
          } catch (retryError) {
            error = retryError;
          }
        }

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

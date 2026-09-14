import { useCallback } from 'react';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  buildSessionCreateRequest,
  invokeCloseSession,
  invokeCreateLocalSession,
  invokeCreateSession,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { promptForMissingPassword } from '@/lib/connections/password-prompt';
import { getErrorMessage, getLocalizedErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  getMissingKeychainKeyTarget,
  promptForMissingKeychainKey,
} from '@/lib/connections/keychain-key-prompt';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';

const logger = createLogger('reconnect');

// Sessions with a reconnect in flight (password prompt + session creation);
// a concurrent reconnect for the same session is ignored.
const reconnectInFlight = new Set<string>();
const AUTO_RECONNECT_DELAYS_MS = [0, 3_000, 6_000, 12_000, 24_000] as const;

function retryableConnectionError(error: unknown): boolean {
  const type = typeof error === 'object' && error !== null && 'type' in error
    ? String(error.type) : '';
  if (type === 'HostKeyUnknown' || type === 'HostKeyMismatch') return false;
  const message = getErrorMessage(error);
  if (/auth|host.?key|credential|password|permission|denied/i.test(message)) return false;
  return /connect|network|offline|unreachable|timeout|timed out|reset|refused|broken pipe/i.test(message);
}

function waitForConnectionRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener('online', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, delayMs);
    window.addEventListener('online', finish, { once: true });
  });
}

export function useReconnectSession(): (sessionId: string, automatic?: boolean) => Promise<void> {
  const { t } = useI18n();
  return useCallback(async (sessionId: string, automatic = false): Promise<void> => {
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
      let activeProfile = preparedProfile;

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
          .startAutoForOwner(activeProfile, `terminal:${summary.sessionId}`);
        logger.info(`Reconnected session ${sessionId} as session ${summary.sessionId}`);
        invokeCloseSession(sessionId).catch((error) => {
          logger.warn(`Failed to close replaced session ${sessionId}`, error);
        });
      };

      const limit = automatic ? AUTO_RECONNECT_DELAYS_MS.length : 1;
      let keyRecoveryUsed = false;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        if (attempt > 0) {
          const delayMs = AUTO_RECONNECT_DELAYS_MS[attempt];
          setStatus(sessionId, {
            sessionId,
            status: 'connecting',
            message: t('terminal.notice.reconnectRetryIn', { seconds: delayMs / 1_000 }),
          });
          await waitForConnectionRetry(delayMs);
          if (!useTerminalStore.getState().sessions.some((item) => item.sessionId === sessionId)) return;
          if (!useAppStore.getState().terminalAutoReconnect) {
            setStatus(sessionId, { sessionId, status: 'disconnected',
              message: t('terminal.notice.pressEnterReconnect') });
            return;
          }
        }
        setStatus(sessionId, {
          sessionId,
          status: 'connecting',
          message: t('terminal.notice.reconnectingLabel'),
        });
        try {
          const summary = await invokeCreateSession(
            buildSessionCreateRequest(activeProfile, cols, rows),
          );
          await replaceSession(summary);
          return;
        } catch (failure) {
          let error: unknown = failure;
          const missingKeyTarget = !keyRecoveryUsed
            ? getMissingKeychainKeyTarget(activeProfile, getErrorMessage(error)) : null;
          if (missingKeyTarget) {
            keyRecoveryUsed = true;
            const recoveredProfile = await promptForMissingKeychainKey(activeProfile, missingKeyTarget);
            if (!recoveredProfile) {
              logger.info(`Reconnect cancelled by user for session ${sessionId}`);
              setStatus(sessionId, { sessionId, status: 'disconnected',
                message: t('terminal.notice.pressEnterReconnect') });
              return;
            }
            activeProfile = recoveredProfile;
            try {
              const summary = await invokeCreateSession(
                buildSessionCreateRequest(activeProfile, cols, rows),
              );
              await replaceSession(summary);
              return;
            } catch (retryError) {
              error = retryError;
            }
          }
          if (automatic && attempt + 1 < limit && retryableConnectionError(error)) {
            logger.warn(`Reconnect attempt ${attempt + 1} failed for ${sessionId}`, error);
            continue;
          }
          logger.error(`Failed to reconnect session ${sessionId}`, error);
          setStatus(sessionId, {
            sessionId,
            status: 'error',
            message: getLocalizedErrorMessage(error),
          });
          return;
        }
      }
    } finally {
      useTerminalStore.getState().setReconnecting(sessionId, false);
      reconnectInFlight.delete(sessionId);
    }
  }, [t]);
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import { createLogger, initGlobalErrorLogging } from './lib/logger';
import { applyTheme } from './lib/theme';
import { parseTerminalWorkspace } from './lib/terminal-workspace';
import { parseSftpWorkspace } from './lib/sftp-workspace';
import {
  invokeClearSftpWorkspace,
  invokeClearTerminalWorkspace,
  invokeListAiSessions,
  invokeLoadSftpWorkspace,
  invokeLoadTerminalWorkspace,
} from './lib/tauri';
import { useAppStore } from './stores/appStore';
import { useProfileStore } from './stores/profileStore';
import { useRecentProfilesStore } from './stores/recentProfilesStore';
import { useTerminalStore } from './stores/terminalStore';
import { useAiSettingsStore } from './stores/aiSettingsStore';
import { useAiStore } from './stores/aiStore';
import { useSftpStore } from './stores/sftpStore';
import { hydrateTransferResumeCandidates } from './lib/transfer-resume';
import { initializeAgentSessionPersistence } from './lib/agent-sessions';

initGlobalErrorLogging();
initializeAgentSessionPersistence();

const logger = createLogger('bootstrap');

function auditRecoveredAiSessionIndex(
  sessions: Awaited<ReturnType<typeof invokeListAiSessions>>,
): void {
  for (const session of sessions) {
    if (!session.recovery) continue;
    logger.warn(
      `AI session index includes recovered history conversation_id=${session.id}`,
      session.recovery,
    );
  }
}

async function bootstrap(): Promise<void> {
  await Promise.all([
    useAppStore.getState().hydrateFromDb(),
    useProfileStore.getState().hydrateFromDb(),
    useRecentProfilesStore.getState().hydrateFromDb(),
    useAiSettingsStore.getState().hydrateFromDb(),
  ]);
  try {
    const sessions = await invokeListAiSessions();
    auditRecoveredAiSessionIndex(sessions);
    useAiStore.getState().hydrateSessionIndex(sessions);
  } catch (error) {
    // Local AI history is best-effort and must not block application startup.
    logger.warn('Failed to load the local AI session index during startup', error);
  }
  if (useAppStore.getState().restoreWorkspace) {
    await Promise.all([
      invokeLoadTerminalWorkspace()
        .then((rawWorkspace) => {
          const workspace = parseTerminalWorkspace(rawWorkspace);
          useTerminalStore.getState().addRestoredSessions(workspace.sessions, workspace.layout);
        })
        .catch(() => {}),
      invokeLoadSftpWorkspace()
        .then((rawWorkspace) => {
          const workspace = parseSftpWorkspace(rawWorkspace);
          useSftpStore.getState().addRestoredConnections(
            workspace.tabs,
            workspace.activeConnectionId,
            useProfileStore.getState().profiles,
          );
        })
        .catch(() => {}),
    ]);
  } else {
    await Promise.allSettled([
      invokeClearTerminalWorkspace(),
      invokeClearSftpWorkspace(),
    ]);
  }
  await hydrateTransferResumeCandidates().catch(() => {
    // Interrupted transfers are optional recovery metadata and never block startup.
  });
  applyTheme(useAppStore.getState().theme);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();

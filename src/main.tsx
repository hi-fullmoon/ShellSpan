import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import { initGlobalErrorLogging } from './lib/logger';
import { applyTheme } from './lib/theme';
import { parseTerminalWorkspace } from './lib/terminal-workspace';
import { parseSftpWorkspace } from './lib/sftp-workspace';
import {
  invokeClearSftpWorkspace,
  invokeClearTerminalWorkspace,
  invokeLoadSftpWorkspace,
  invokeLoadTerminalWorkspace,
} from './lib/tauri';
import { useAppStore } from './stores/appStore';
import { useProfileStore } from './stores/profileStore';
import { useRecentProfilesStore } from './stores/recentProfilesStore';
import { useTerminalStore } from './stores/terminalStore';
import { useAiSettingsStore } from './stores/aiSettingsStore';
import { useSftpStore } from './stores/sftpStore';
import { hydrateTransferResumeCandidates } from './lib/transfer-resume';

initGlobalErrorLogging();

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (import.meta.env.DEV && params.has('aiStage6dVisual')) {
    const { mountFilesPage } = await import('./test/agent-files-page');
    await mountFilesPage(document.getElementById('root')!);
    return;
  }
  if (import.meta.env.DEV && params.has('aiStage6cVisual')) {
    const { mountImagesPage } = await import('./test/agent-images-page');
    await mountImagesPage(document.getElementById('root')!);
    return;
  }
  if (import.meta.env.DEV && params.has('aiStage6aVisual')) {
    const { mountQuestionPage } = await import('./test/agent-question-page');
    await mountQuestionPage(document.getElementById('root')!);
    return;
  }
  if (import.meta.env.DEV && params.has('aiStage6bVisual')) {
    const { mountSkillsPage } = await import('./test/agent-skills-page');
    await mountSkillsPage(document.getElementById('root')!);
    return;
  }
  const phase5Scenario = params.get('aiPhase5Visual');
  if (import.meta.env.DEV && phase5Scenario !== null) {
    const { mountAgentSessionPhase5Page } = await import('./test/agent-session-phase5-page');
    await mountAgentSessionPhase5Page(document.getElementById('root')!);
    return;
  }
  const baselineScenario = params.get('aiPhase0Baseline');
  if (import.meta.env.DEV && baselineScenario !== null) {
    const { mountAgentSessionBaselinePage } = await import('./test/agent-session-baseline-page');
    await mountAgentSessionBaselinePage(document.getElementById('root')!);
    return;
  }
  await Promise.all([
    useAppStore.getState().hydrateFromDb(),
    useProfileStore.getState().hydrateFromDb(),
    useRecentProfilesStore.getState().hydrateFromDb(),
    useAiSettingsStore.getState().hydrateFromDb(),
  ]);
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

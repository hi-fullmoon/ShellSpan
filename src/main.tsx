import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import { initGlobalErrorLogging } from './lib/logger';
import { applyTheme } from './lib/theme';
import { parseTerminalWorkspace } from './lib/terminal-workspace';
import {
  invokeClearTerminalWorkspace,
  invokeLoadTerminalWorkspace,
} from './lib/tauri';
import { useAppStore } from './stores/appStore';
import { useProfileStore } from './stores/profileStore';
import { useRecentProfilesStore } from './stores/recentProfilesStore';
import { useTerminalStore } from './stores/terminalStore';

initGlobalErrorLogging();

async function bootstrap(): Promise<void> {
  await Promise.all([
    useAppStore.getState().hydrateFromDb(),
    useProfileStore.getState().hydrateFromDb(),
    useRecentProfilesStore.getState().hydrateFromDb(),
  ]);
  if (useAppStore.getState().restoreWorkspace) {
    try {
      const rawWorkspace = await invokeLoadTerminalWorkspace();
      useTerminalStore.getState().addRestoredSessions(parseTerminalWorkspace(rawWorkspace));
    } catch {
      // Workspace restoration is best-effort and must not block application startup.
    }
  } else {
    try {
      await invokeClearTerminalWorkspace();
    } catch {
      // Clearing stale workspace data is retried when the terminal view mounts.
    }
  }
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

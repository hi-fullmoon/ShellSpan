import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import { initGlobalErrorLogging } from './lib/logger';
import { applyTheme } from './lib/theme';
import { useAppStore } from './stores/appStore';
import { useProfileStore } from './stores/profileStore';
import { useRecentProfilesStore } from './stores/recentProfilesStore';

initGlobalErrorLogging();

async function bootstrap(): Promise<void> {
  await Promise.all([
    useAppStore.getState().hydrateFromDb(),
    useProfileStore.getState().hydrateFromDb(),
    useRecentProfilesStore.getState().hydrateFromDb(),
  ]);
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

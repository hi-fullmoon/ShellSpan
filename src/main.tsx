import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { App } from './App';
import { AppErrorBoundary } from './components/app-error-boundary';
import { initGlobalErrorLogging } from './lib/logger';

initGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

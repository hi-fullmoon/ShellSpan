import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { SettingsApp } from './SettingsApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);

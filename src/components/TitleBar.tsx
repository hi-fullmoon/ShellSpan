import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState } from 'react';
import { PrimarySidebarActiveIcon, PrimarySidebarIcon, SecondarySidebarActiveIcon, SecondarySidebarIcon } from './Icons';
import { Tooltip } from './Tooltip';
import { isTauriRuntime } from '../lib/tauri';

interface TitleBarProps {
  primarySideVisible: boolean;
  secondarySideVisible: boolean;
  onTogglePrimarySide: () => void;
  onToggleSecondarySide: () => void;
}

const IS_MAC = /mac/i.test(navigator.platform);

export function TitleBar({
  primarySideVisible,
  secondarySideVisible,
  onTogglePrimarySide,
  onToggleSecondarySide,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const isTauri = isTauriRuntime();

  useEffect(() => {
    if (!isTauri) return;
    const window = getCurrentWindow();
    const unlisten = window.onResized(() => {
      void window.isMaximized().then(setIsMaximized);
    });
    void window.isMaximized().then(setIsMaximized);
    return () => {
      void unlisten.then((f) => f());
    };
  }, [isTauri]);

  const handleMinimize = useCallback(() => {
    if (isTauri) void getCurrentWindow().minimize();
  }, [isTauri]);

  const handleMaximize = useCallback(() => {
    if (!isTauri) return;
    const window = getCurrentWindow();
    void window.isMaximized().then((max) => {
      if (max) {
        void window.unmaximize();
      } else {
        void window.maximize();
      }
    });
  }, [isTauri]);

  const handleClose = useCallback(() => {
    if (isTauri) void getCurrentWindow().close();
  }, [isTauri]);

  return (
    <div
      className={`title-bar${IS_MAC ? ' title-bar-mac' : ''}${isTauri && !IS_MAC ? ' title-bar-windows' : ''}`}
      data-tauri-drag-region
    >
      <div className="title-bar-left" data-tauri-drag-region />

      <div className="title-bar-center" data-tauri-drag-region>
        <span className="title-bar-app-name" data-tauri-drag-region>TermBridge</span>
      </div>

      <div className="title-bar-right" data-tauri-drag-region>
        <button
          aria-label={primarySideVisible ? 'Hide primary side' : 'Show primary side'}
          className="title-bar-btn"
          onClick={onTogglePrimarySide}
          type="button"
        >
          <Tooltip content={primarySideVisible ? 'Hide Explorer' : 'Show Explorer'}>
            {primarySideVisible ? <PrimarySidebarActiveIcon /> : <PrimarySidebarIcon />}
          </Tooltip>
        </button>
        <button
          aria-label={secondarySideVisible ? 'Hide secondary side' : 'Show secondary side'}
          className="title-bar-btn"
          onClick={onToggleSecondarySide}
          type="button"
        >
          <Tooltip content={secondarySideVisible ? 'Hide Sidebar' : 'Show Sidebar'}>
            {secondarySideVisible ? <SecondarySidebarActiveIcon /> : <SecondarySidebarIcon />}
          </Tooltip>
        </button>

        {isTauri && !IS_MAC && (
          <div className="title-bar-window-controls">
            <button
              aria-label="Minimize"
              className="title-bar-window-btn title-bar-window-btn-minimize"
              onClick={handleMinimize}
              type="button"
            >
              <Tooltip content="Minimize">
                <MinimizeIcon />
              </Tooltip>
            </button>
            <button
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
              className="title-bar-window-btn title-bar-window-btn-maximize"
              onClick={handleMaximize}
              type="button"
            >
              <Tooltip content={isMaximized ? 'Restore' : 'Maximize'}>
                {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
              </Tooltip>
            </button>
            <button
              aria-label="Close"
              className="title-bar-window-btn title-bar-window-btn-close"
              onClick={handleClose}
              type="button"
            >
              <Tooltip content="Close">
                <CloseWindowIcon />
              </Tooltip>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MinimizeIcon() {
  return (
    <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
      <path d="M1 5h8" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
      <rect height="7" rx="1" width="7" x="1.5" y="1.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
      <rect height="5.5" rx="1" width="5.5" x="1.5" y="3" />
      <path d="M3.5 3V1.5h5v5H7" />
    </svg>
  );
}

function CloseWindowIcon() {
  return (
    <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
      <path d="m2 2 6 6" />
      <path d="m8 2-6 6" />
    </svg>
  );
}

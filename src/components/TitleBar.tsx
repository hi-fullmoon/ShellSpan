import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState } from 'react';
import { isTauriRuntime } from '../lib/tauri';
import { Tooltip } from './ui';
import { SectionSwitcher } from './SectionSwitcher';
import type { AppSection } from '../types';

interface TitleBarProps {
  activeSection: AppSection;
  onSectionChange: (section: AppSection) => void;
}

const IS_MAC = /mac/i.test(navigator.platform);

export function TitleBar({ activeSection, onSectionChange }: TitleBarProps) {
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
      <div className="title-bar-left flex items-center" data-tauri-drag-region>
        <div className="flex h-full items-center pl-1" style={{ appRegion: 'no-drag', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SectionSwitcher value={activeSection} onChange={onSectionChange} />
        </div>
        {IS_MAC ? <div className="flex-1" data-tauri-drag-region /> : null}
      </div>

      <div className="title-bar-center" data-tauri-drag-region>
        <span className="title-bar-app-name" data-tauri-drag-region>TermBridge</span>
      </div>

      <div className="title-bar-right" data-tauri-drag-region>
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

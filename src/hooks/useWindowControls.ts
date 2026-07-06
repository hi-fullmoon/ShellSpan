import { useCallback, useEffect, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface WindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: boolean;
}

export function useWindowControls(): WindowControls {
  const window = getCurrentWebviewWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  const updateMaximized = useCallback(async (): Promise<void> => {
    try {
      const maximized = await window.isMaximized();
      setIsMaximized(maximized);
    } catch {
      // ignore
    }
  }, [window]);

  useEffect(() => {
    void updateMaximized();

    let unlisten: (() => void) | undefined;

    const setup = async (): Promise<void> => {
      try {
        unlisten = await window.onResized(() => {
          void updateMaximized();
        });
      } catch {
        // ignore
      }
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [updateMaximized, window]);

  const minimize = useCallback(async (): Promise<void> => {
    try {
      await window.minimize();
    } catch {
      // ignore
    }
  }, [window]);

  const toggleMaximize = useCallback(async (): Promise<void> => {
    try {
      if (isMaximized) {
        await window.unmaximize();
      } else {
        await window.maximize();
      }
      await updateMaximized();
    } catch {
      // ignore
    }
  }, [isMaximized, updateMaximized, window]);

  const close = useCallback(async (): Promise<void> => {
    try {
      await window.close();
    } catch {
      // ignore
    }
  }, [window]);

  return {
    minimize,
    toggleMaximize,
    close,
    isMaximized,
  };
}

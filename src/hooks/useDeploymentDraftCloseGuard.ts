import React from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';

export interface DeploymentDraftCloseGuard {
  confirmOpen: boolean;
  cancelClose: () => void;
  confirmClose: () => void;
}

/**
 * Intercepts the main window's close request while a deployment workflow draft
 * has unsaved changes. The Rust side either hides the window to the tray or
 * forwards macOS closes to the global app-exit flow, so the window may already
 * be hidden when the dialog opens; it is shown again in that case. Confirming
 * discards the draft by letting the close go through (with the guard bypassed).
 */
export function useDeploymentDraftCloseGuard(): DeploymentDraftCloseGuard {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const bypassRef = React.useRef(false);
  const unlistenRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    const window = getCurrentWebviewWindow();
    let disposed = false;
    void window
      .onCloseRequested((event) => {
        if (bypassRef.current) return;
        const state = useDeploymentWorkflowStore.getState();
        const dirty = state.draft !== null && (state.semanticDirty || state.layoutDirty);
        if (!dirty) return;
        event.preventDefault();
        setConfirmOpen(true);
        // The Rust close handler hides the window (tray) before JS sees the
        // event on Windows/Linux, so bring it back to make the prompt visible.
        void window.show().catch(() => undefined);
        void window.setFocus().catch(() => undefined);
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const cancelClose = React.useCallback((): void => {
    setConfirmOpen(false);
  }, []);

  const confirmClose = React.useCallback((): void => {
    bypassRef.current = true;
    unlistenRef.current?.();
    unlistenRef.current = null;
    setConfirmOpen(false);
    const window = getCurrentWebviewWindow();
    void window
      .close()
      .catch(() => {
        bypassRef.current = false;
      });
  }, []);

  return { confirmOpen, cancelClose, confirmClose };
}

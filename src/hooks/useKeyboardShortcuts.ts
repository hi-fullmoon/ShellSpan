import { useEffect, useRef } from 'react';
import { DEFAULT_SHORTCUTS, matchesBinding } from '../lib/keyboard';

interface DialogState {
  hostKeyOpen: boolean;
  connectOpen: boolean;
  settingsOpen: boolean;
  pendingDelete: boolean;
  pendingClose: boolean;
  exitOpen: boolean;
}

interface KeyboardHandlers {
  closeHostKeyDialog: () => void;
  closeConnectDialog: () => void;
  closeSettingsDialog: () => void;
  cancelPendingDelete: () => void;
  cancelPendingClose: () => void;
  closeExitDialog: () => void;
  openNewConnection: () => void;
  openSettings: () => void;
  requestCloseActiveSession: () => void;
  selectNextTab: () => void;
  selectPrevTab: () => void;
  togglePrimarySidebar: () => void;
  toggleSecondarySidebar: () => void;
  exportActiveTerminal: () => void;
}

export interface UseKeyboardShortcutsOptions {
  keyboardShortcuts: Record<string, string> | undefined;
  showFileManager: boolean;
  showSidebar: boolean;
  activeSessionId: string | undefined;
  dialogState: DialogState;
  handlers: KeyboardHandlers;
}

export function useKeyboardShortcuts({
  keyboardShortcuts,
  showFileManager,
  showSidebar,
  activeSessionId,
  dialogState,
  handlers,
}: UseKeyboardShortcutsOptions) {
  const dialogStateRef = useRef(dialogState);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    dialogStateRef.current = dialogState;
  }, [dialogState]);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const merged = { ...DEFAULT_SHORTCUTS, ...keyboardShortcuts };

    const onKeyDown = (event: KeyboardEvent) => {
      const h = handlersRef.current;
      // Check if an input element is focused (allow xterm's hidden textarea)
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName.toLowerCase();
      const isXterm = activeEl && (activeEl as HTMLElement).classList.contains('xterm-helper-textarea');
      const isInput = !isXterm && (tag === 'input' || tag === 'textarea' || tag === 'select');

      const dlg = dialogStateRef.current;
      const anyDialogOpen = dlg.hostKeyOpen || dlg.connectOpen || dlg.settingsOpen || dlg.pendingDelete || dlg.pendingClose || dlg.exitOpen;

      // Escape always closes the active dialog, even if input is focused
      if (matchesBinding(merged.closeDialog, event)) {
        if (dlg.hostKeyOpen) {
          h.closeHostKeyDialog();
          event.preventDefault();
          return;
        }
        if (dlg.connectOpen) {
          h.closeConnectDialog();
          event.preventDefault();
          return;
        }
        if (dlg.settingsOpen) {
          h.closeSettingsDialog();
          event.preventDefault();
          return;
        }
        if (dlg.pendingDelete) {
          h.cancelPendingDelete();
          event.preventDefault();
          return;
        }
        if (dlg.pendingClose) {
          h.cancelPendingClose();
          event.preventDefault();
          return;
        }
        if (dlg.exitOpen) {
          h.closeExitDialog();
          event.preventDefault();
          return;
        }
        return;
      }

      // Skip other shortcuts when a dialog or input is active
      if (anyDialogOpen || isInput) return;

      if (matchesBinding(merged.newConnection, event)) {
        event.preventDefault();
        h.openNewConnection();
        return;
      }

      if (matchesBinding(merged.openSettings, event)) {
        event.preventDefault();
        h.openSettings();
        return;
      }

      if (matchesBinding(merged.closeSession, event)) {
        event.preventDefault();
        h.requestCloseActiveSession();
        return;
      }

      if (matchesBinding(merged.nextTab, event)) {
        event.preventDefault();
        h.selectNextTab();
        return;
      }

      if (matchesBinding(merged.prevTab, event)) {
        event.preventDefault();
        h.selectPrevTab();
        return;
      }

      if (matchesBinding(merged.togglePrimarySidebar, event)) {
        event.preventDefault();
        h.togglePrimarySidebar();
        return;
      }

      if (matchesBinding(merged.toggleSecondarySidebar, event)) {
        event.preventDefault();
        h.toggleSecondarySidebar();
        return;
      }

      if (matchesBinding(merged.exportTerminal, event)) {
        event.preventDefault();
        h.exportActiveTerminal();
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keyboardShortcuts, showFileManager, showSidebar, activeSessionId]);
}

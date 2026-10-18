import { useCallback } from 'react';
import { invokeCloseSession } from '@/lib/ipc/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { useI18n } from './useI18n';
import { useToast } from './useToast';

const pendingCloses = new Map<string, Promise<void>>();

export function useCloseTerminal(): (sessionId: string) => Promise<void> {
  const { t } = useI18n();
  const { error } = useToast();
  return useCallback((sessionId: string): Promise<void> => {
    const pending = pendingCloses.get(sessionId);
    if (pending) return pending;
    const session = useTerminalStore.getState().sessions.find(item => item.sessionId === sessionId);
    const close = (async () => {
      try {
        await invokeCloseSession(sessionId);
        useTerminalStore.getState().removeSession(sessionId);
      } catch {
        error(t('terminal.tab.closeFailed', { title: session?.title ?? sessionId }));
      } finally {
        pendingCloses.delete(sessionId);
      }
    })();
    pendingCloses.set(sessionId, close);
    return close;
  }, [error, t]);
}

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { useConnectSession } from '../useConnectSession';
import { useSftpConnectionOpener } from '../useSftpConnectionOpener';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainStore } from '@/stores/keychainStore';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import type { AppSection, ConnectionProfile } from '@/types';

function snapshotStore<T>(store: StoreApi<T>): () => void {
  const state = store.getState();
  return () => store.setState(state, true);
}

const restoreStates = [
  snapshotStore(useAppStore),
  snapshotStore(useTerminalStore),
  snapshotStore(useSftpStore),
  snapshotStore(useProfileStore),
  snapshotStore(useKeychainStore),
];

describe('connection prompt cancellation with real stores and prompts', () => {
  beforeEach(() => {
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useSftpStore.setState({ connections: [], activeConnectionId: null });
    useProfileStore.setState({ profiles: [] });
    useKeychainStore.setState({ initialized: true, keys: [], loadError: undefined });
  });

  afterEach(() => {
    usePasswordPromptStore.getState().resolvePassword(null);
    useKeychainKeyPromptStore.getState().resolveKey(null);
    restoreStates.forEach((restore) => restore());
  });

  it.each(['local', 'remote'] as const)('preserves the SFTP %s pane when cancelling attachment', async (side) => {
    useSftpStore.getState().addLocalConnection();
    const targetId = useSftpStore.getState().activeConnectionId!;
    useSftpStore.getState().addLocalConnection();
    const originalId = useSftpStore.getState().activeConnectionId;
    const originalConnections = useSftpStore.getState().connections;
    useAppStore.setState({ activeSection: 'sftp' });
    const { result } = renderHook(() => useSftpConnectionOpener());
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.open({
        id: 'cancelled-attachment', name: 'Cancelled attachment',
        host: '127.0.0.1', port: 22, username: 'cancelled', authMethod: 'key',
        keychainKeyId: 'missing-key', createdAt: 0, updatedAt: 0,
      }, targetId, side);
    });
    await waitFor(() => expect(useKeychainKeyPromptStore.getState().pending).not.toBeNull());
    expect(useSftpStore.getState().connections).toEqual(originalConnections);
    await act(async () => {
      useKeychainKeyPromptStore.getState().resolveKey(null);
      await opening;
    });
    expect(useSftpStore.getState().connections).toEqual(originalConnections);
    expect(useSftpStore.getState().activeConnectionId).toBe(originalId);
    expect(useAppStore.getState().activeSection).toBe('sftp');
  });

  for (const destination of ['terminal', 'sftp'] as const) {
    for (const origin of ['workbench', 'terminal', 'sftp'] satisfies AppSection[]) {
      for (const authMethod of ['password', 'key'] as const) {
        it(`keeps ${origin} when cancelling the ${destination} ${authMethod} prompt`, async () => {
          useAppStore.setState({ activeSection: origin });
          for (const sessionId of ['session-a', 'session-b']) {
            useTerminalStore.getState().addSession({
              sessionId, title: sessionId, host: '127.0.0.1', port: 22, username: 'cancelled',
            });
            useSftpStore.getState().addLocalConnection();
          }
          useTerminalStore.getState().setActiveSession('session-a');
          const originalSessions = useTerminalStore.getState().sessions;
          const originalConnections = useSftpStore.getState().connections;
          const originalConnectionId = originalConnections[0].id;
          useSftpStore.getState().setActiveConnection(originalConnectionId);
          const profile: ConnectionProfile = {
            id: 'cancelled-connection', name: 'Cancelled connection',
            host: '127.0.0.1', port: 22, username: 'cancelled', authMethod,
            keychainKeyId: authMethod === 'key' ? 'missing-key' : undefined,
            createdAt: 0, updatedAt: 0,
          };
          const { result } = renderHook(() => {
            const terminal = useConnectSession();
            const sftp = useSftpConnectionOpener();
            return destination === 'terminal' ? terminal.connect : sftp.open;
          });
          let opening!: Promise<void>;
          act(() => { opening = result.current(profile); });
          await waitFor(() => {
            const pending = authMethod === 'password'
              ? usePasswordPromptStore.getState().pending
              : useKeychainKeyPromptStore.getState().pending;
            expect(pending?.request.profileId).toBe(profile.id);
          });
          expect(useAppStore.getState().activeSection).toBe(origin);
          expect(useTerminalStore.getState().activeSessionId).toBe('session-a');
          expect(useSftpStore.getState().activeConnectionId).toBe(originalConnectionId);
          await act(async () => {
            if (authMethod === 'password') usePasswordPromptStore.getState().resolvePassword(null);
            else useKeychainKeyPromptStore.getState().resolveKey(null);
            await opening;
          });
          expect(useAppStore.getState().activeSection).toBe(origin);
          expect(useTerminalStore.getState().sessions).toEqual(originalSessions);
          expect(useTerminalStore.getState().activeSessionId).toBe('session-a');
          expect(useSftpStore.getState().connections).toEqual(originalConnections);
          expect(useSftpStore.getState().activeConnectionId).toBe(originalConnectionId);
        });
      }
    }
  }
});

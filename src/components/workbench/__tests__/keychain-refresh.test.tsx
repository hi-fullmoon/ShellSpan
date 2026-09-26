import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { KeychainPanel } from '../keychain-panel';
import { useKeychainStore } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import * as ipc from '@/lib/ipc/tauri';

describe('credential refresh lifecycle', () => {
  const initialKeychain = useKeychainStore.getState();
  const initialProfiles = useProfileStore.getState();

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useKeychainStore.setState(initialKeychain, true);
    useProfileStore.setState(initialProfiles, true);
  });

  it('requests current credentials every time an initialized panel is opened', async () => {
    // Observe the real IPC adapter without replacing it. Outside Tauri the
    // request fails, which also exercises the real refresh failure path.
    const requests = vi.spyOn(ipc, 'invokeListKeyCredentials');
    useKeychainStore.setState({ initialized: true });
    const first = render(<KeychainPanel />);
    await waitFor(() => expect(useKeychainStore.getState().initialized).toBe(false));
    expect(requests).toHaveBeenCalledTimes(1);
    first.unmount();

    useKeychainStore.setState({ initialized: true });
    render(<KeychainPanel />);
    await waitFor(() => expect(useKeychainStore.getState().initialized).toBe(false));
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it('refreshes on connection changes without retrying on loading state changes', async () => {
    const requests = vi.spyOn(ipc, 'invokeListKeyCredentials');
    useKeychainStore.setState({ initialized: true });
    const panel = render(<KeychainPanel />);
    await waitFor(() => expect(useKeychainStore.getState().initialized).toBe(false));
    expect(requests).toHaveBeenCalledTimes(1);

    await act(async () => {
      useProfileStore.setState(({ profiles }) => ({ profiles: [...profiles] }));
    });
    expect(requests).toHaveBeenCalledTimes(2);

    panel.rerender(<KeychainPanel />);
    expect(requests).toHaveBeenCalledTimes(2);
  });
});

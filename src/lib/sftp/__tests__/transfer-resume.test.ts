import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';
import { sshRouteKey } from '@/lib/connections/ssh-route';

const tauriMocks = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  copyRemoteToRemote: vi.fn(),
  cancelRemoteCopy: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeLoadPreferences: tauriMocks.loadPreferences,
  invokeSavePreferences: tauriMocks.savePreferences,
  invokeCopyRemoteToRemote: tauriMocks.copyRemoteToRemote,
  invokeCancelRemoteCopy: tauriMocks.cancelRemoteCopy,
}));

import {
  hydrateTransferResumeCandidates,
  parseTransferResumeCandidates,
} from '@/lib/sftp/transfer-resume';
import {
  clearDirectoryListingCache,
  getCachedDirectoryListing,
  setCachedDirectoryListing,
} from '@/lib/sftp/directory-listing-cache';
import { useProfileStore } from '@/stores/profileStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';

const profile = (id: string, host: string) => ({
  id,
  name: id,
  host,
  port: 22,
  username: 'deploy',
  authMethod: 'password' as const,
  password: 'memory-only-secret',
  createdAt: 1,
  updatedAt: 1,
});

const sourceProfile = profile('source-profile', 'source.example.test');
const destinationProfile = profile('destination-profile', 'destination.example.test');
const candidate = {
  schemaVersion: 1 as const,
  operationId: 'copy-resume-1',
  sourceProfileId: sourceProfile.id,
  destinationProfileId: destinationProfile.id,
  sourceRouteKey: sshRouteKey(sourceProfile),
  destinationRouteKey: sshRouteKey(destinationProfile),
  sourcePaths: ['/var/data/archive.tar'],
  destinationDirectory: '/backup',
  conflictPolicies: ['overwrite' as const],
  createdAt: '2026-08-23T00:00:00.000Z',
};

describe('transfer resume metadata', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n('en-US');
    useTransferStore.setState({ operations: [] });
    useProfileStore.setState({
      profiles: [sourceProfile, destinationProfile],
      initialized: true,
    });
    tauriMocks.loadPreferences.mockResolvedValue([
      ['transferResumeCandidates', JSON.stringify([candidate])],
    ]);
    tauriMocks.savePreferences.mockResolvedValue(undefined);
    tauriMocks.copyRemoteToRemote.mockResolvedValue({ items: [] });
    tauriMocks.cancelRemoteCopy.mockResolvedValue(undefined);
  });

  it('rejects malformed or secret-bearing lookalike records', () => {
    expect(parseTransferResumeCandidates('{broken')).toEqual([]);
    expect(parseTransferResumeCandidates(JSON.stringify([{
      ...candidate,
      sourcePaths: [],
      password: 'must-never-be-used',
    }]))).toEqual([]);
  });

  it('restores an interrupted row and only resumes after an explicit retry', async () => {
    await hydrateTransferResumeCandidates();

    const restored = useTransferStore.getState().operations[0];
    expect(restored).toMatchObject({
      operationId: candidate.operationId,
      status: 'failed',
      kind: 'remote-copy',
      pathScopes: [
        { connectionId: candidate.sourceRouteKey, paths: candidate.sourcePaths },
        { connectionId: candidate.destinationRouteKey, paths: ['/backup/archive.tar'] },
      ],
    });
    expect(tauriMocks.copyRemoteToRemote).not.toHaveBeenCalled();

    await useTransferStore.getState().retryOperation(candidate.operationId);

    expect(tauriMocks.copyRemoteToRemote).toHaveBeenCalledWith(expect.objectContaining({
      operationId: candidate.operationId,
      sourcePaths: candidate.sourcePaths,
      destinationDirectory: candidate.destinationDirectory,
    }));
    expect(useTransferStore.getState().operations[0]?.status).toBe('completed');
    expect(tauriMocks.savePreferences).toHaveBeenLastCalledWith([
      ['transferResumeCandidates', '[]'],
    ]);
  });

  it('keeps a non-resumable row when a referenced profile was deleted', async () => {
    useProfileStore.setState({ profiles: [profile('source-profile', 'source.example.test')] });

    await hydrateTransferResumeCandidates();

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      status: 'failed',
      errorCategory: 'not-found',
      retry: undefined,
    });
  });

  it('blocks retries when a saved profile changes endpoints', async () => {
    useProfileStore.setState({ profiles: [sourceProfile, { ...destinationProfile, host: 'other.example.test' }] });
    await hydrateTransferResumeCandidates();

    expect(useTransferStore.getState().operations[0]?.retry).toBeUndefined();
    await useTransferStore.getState().retryOperation(candidate.operationId);
    expect(tauriMocks.copyRemoteToRemote).not.toHaveBeenCalled();
  });

  it('invalidates destination listing cache for escaped route keys and requests selection-preserving refresh', async () => {
    clearDirectoryListingCache();
    useSftpStore.setState({ connections: [], activeConnectionId: null });
    useSftpStore.getState().addConnection(
      { sessionId: 's1', title: 'Dest', host: destinationProfile.host, port: 22, username: 'deploy' },
      { host: destinationProfile.host, port: 22, username: 'deploy', authMethod: 'password' },
    );
    const connId = useSftpStore.getState().connections[0]!.id;
    useSftpStore.getState().setPath(connId, 'remote', '/backup/');

    const destScope = JSON.stringify([connId, 'remote', candidate.destinationRouteKey, 'dest-profile', 'password']);
    const otherRouteKey = sshRouteKey({ ...destinationProfile, port: 2200 });
    const otherScope = JSON.stringify(['other-conn', 'remote', otherRouteKey, 'other', 'password']);
    setCachedDirectoryListing(destScope, '/backup', { path: '/backup', entries: [] });
    setCachedDirectoryListing(otherScope, '/backup', { path: '/backup', entries: [] });

    const refreshEvents: Array<{ connectionId?: string; side?: string; path?: string; preserveSelection?: boolean }> = [];
    const listener = (event: Event): void => {
      refreshEvents.push((event as CustomEvent).detail);
    };
    document.addEventListener('shellspan:open-sftp-path', listener);
    try {
      await hydrateTransferResumeCandidates();
      await useTransferStore.getState().retryOperation(candidate.operationId);
    } finally {
      document.removeEventListener('shellspan:open-sftp-path', listener);
    }

    expect(getCachedDirectoryListing(destScope, '/backup')).toBeUndefined();
    expect(getCachedDirectoryListing(otherScope, '/backup')).toBeDefined();
    expect(refreshEvents).toContainEqual({
      connectionId: connId,
      side: 'remote',
      path: '/backup/',
      preserveSelection: true,
    });
  });
});

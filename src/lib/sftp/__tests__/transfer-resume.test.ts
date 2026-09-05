import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/locales';

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
import { useProfileStore } from '@/stores/profileStore';
import { useTransferStore } from '@/stores/transferStore';

const candidate = {
  schemaVersion: 1 as const,
  operationId: 'copy-resume-1',
  sourceProfileId: 'source-profile',
  destinationProfileId: 'destination-profile',
  sourcePaths: ['/var/data/archive.tar'],
  destinationDirectory: '/backup',
  conflictPolicies: ['overwrite' as const],
  createdAt: '2026-08-23T00:00:00.000Z',
};

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

describe('transfer resume metadata', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n('en-US');
    useTransferStore.setState({ operations: [] });
    useProfileStore.setState({
      profiles: [
        profile('source-profile', 'source.example.test'),
        profile('destination-profile', 'destination.example.test'),
      ],
      initialized: true,
    });
    tauriMocks.loadPreferences.mockResolvedValue([
      ['transferResumeCandidates', JSON.stringify([candidate])],
    ]);
    tauriMocks.savePreferences.mockResolvedValue(undefined);
    tauriMocks.copyRemoteToRemote.mockResolvedValue(undefined);
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
});

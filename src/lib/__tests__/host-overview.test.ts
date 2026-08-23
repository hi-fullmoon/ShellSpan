import { describe, expect, it } from 'vitest';
import { buildHostOverview } from '../host-overview';
import type { ConnectionProfile } from '@/types';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'root',
  authMethod: 'password',
  createdAt: 0,
  updatedAt: 0,
};

describe('buildHostOverview', () => {
  it('aggregates only activity bound to the selected profile', () => {
    const snapshot = buildHostOverview(
      profile,
      [
        { sessionId: 's1', title: 'One', host: profile.host, port: 22, username: 'root', status: 'connected', profileId: profile.id },
        { sessionId: 's2', title: 'Two', host: profile.host, port: 22, username: 'root', status: 'error', profileId: profile.id },
        { sessionId: 'other', title: 'Other', host: 'other', port: 22, username: 'root', status: 'connected', profileId: 'other' },
      ],
      [
        {
          id: 'sftp-1',
          profileId: profile.id,
          title: 'Production',
          connection: { host: profile.host, port: 22, username: 'root', authMethod: 'password' },
          localPath: '/tmp', remotePath: '/srv', localEntries: [], remoteEntries: [],
          localLoading: false, remoteLoading: false,
          localPane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remotePane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
          remoteBookmarks: { local: [], remote: [] }, splitRatio: 0.5,
        },
      ],
      [
        { operationId: 'transfer-1', kind: 'upload', ownerId: 'sftp-1', totalBytes: 10, processedBytes: 2, totalSteps: 1, completedSteps: 0, status: 'running' },
        { operationId: 'transfer-other', kind: 'upload', ownerId: 'other', totalBytes: 10, processedBytes: 2, totalSteps: 1, completedSteps: 0, status: 'running' },
      ],
      [{ sessionId: 's2', host: profile.host, port: 22, username: 'root', reasonKind: 'error', reason: 'transport reset', retryable: true, at: 2 }],
      [{
        operationId: 'forward-1',
        profileId: profile.id,
        configId: 'rule-1',
        name: 'Database',
        kind: 'local',
        mode: 'manual',
        status: 'running',
        startedAt: 1,
        bytesSent: 10,
        bytesReceived: 20,
      }],
      { id: 'agent-1', requestId: 'request-1', goal: 'diagnose', sessionId: 's1', contextLabel: 'root@prod', contextObservedAt: 1_000, phase: 'awaitingReview', responseText: '', steps: [] },
    );

    expect(snapshot).toMatchObject({
      terminalTotal: 2,
      terminals: { connected: 1, error: 1, connecting: 0, disconnected: 0 },
      sftpTabs: 1,
      sftpRemotePanes: 1,
      activeTransfers: 1,
      failedTransfers: 0,
      diagnosticPhase: 'awaitingReview',
      latestError: 'transport reset',
      activePortForwards: 1,
      failedPortForwards: 0,
    });
  });
});

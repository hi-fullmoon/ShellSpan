import { describe, expect, it } from 'vitest';
import { parseSftpWorkspace, serializeSftpWorkspace } from '@/lib/sftp/sftp-workspace';
import type { SftpConnection } from '@/stores/sftpStore';

function connection(): SftpConnection {
  return {
    id: 'tab-1',
    title: 'Production',
    pinned: true,
    profileId: 'profile-right',
    leftProfileId: 'profile-left',
    connection: { host: 'right.example.com', port: 22, username: 'bob', authMethod: 'password', password: 'secret' },
    leftConnection: { host: 'left.example.com', port: 22, username: 'alice', authMethod: 'password', password: 'secret' },
    leftSource: 'remote',
    rightSource: 'remote',
    localPath: '/srv/left',
    remotePath: '/srv/right',
    localEntries: [],
    remoteEntries: [],
    localLoading: false,
    remoteLoading: false,
    localPane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
    remotePane: { pathInput: '', filterQuery: '', selectedPaths: [], batchMode: false },
    remoteBookmarks: { local: ['/srv/left'], remote: ['/srv/right'] },
    splitRatio: 0.4,
  };
}

describe('SFTP workspace serialization', () => {
  it('keeps view state and profile references without persisting credentials or transfers', () => {
    const raw = serializeSftpWorkspace([connection()], 'tab-1');
    const parsed = parseSftpWorkspace(raw);

    expect(parsed.tabs[0]).toMatchObject({
      id: 'tab-1',
      leftProfileId: 'profile-left',
      rightProfileId: 'profile-right',
      localPath: '/srv/left',
      remotePath: '/srv/right',
      splitRatio: 0.4,
    });
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('operation');
  });

  it('drops malformed tabs and repairs an invalid active id', () => {
    const valid = JSON.parse(serializeSftpWorkspace([connection()], 'tab-1'));
    valid.activeConnectionId = 'missing';
    valid.tabs.push({ id: 'unsafe', splitRatio: 2 });

    const parsed = parseSftpWorkspace(JSON.stringify(valid));

    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.activeConnectionId).toBe('tab-1');
  });

  it('rejects unknown versions', () => {
    expect(parseSftpWorkspace('{"version":99,"tabs":[]}').tabs).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSftpWorkspace,
  flushSftpWorkspace,
  stageSftpWorkspace,
} from '@/lib/sftp/sftp-workspace-persistence';
import { invokeClearSftpWorkspace, invokeSaveSftpWorkspace } from '@/lib/ipc/tauri';

vi.mock('@/lib/ipc/tauri', () => ({
  invokeClearSftpWorkspace: vi.fn().mockResolvedValue(undefined),
  invokeSaveSftpWorkspace: vi.fn().mockResolvedValue(undefined),
}));

describe('SFTP workspace persistence', () => {
  beforeEach(async () => {
    await clearSftpWorkspace();
    vi.clearAllMocks();
  });

  it('coalesces staged state and serializes saves', async () => {
    stageSftpWorkspace('old');
    stageSftpWorkspace('latest');
    await flushSftpWorkspace();
    expect(invokeSaveSftpWorkspace).toHaveBeenCalledOnce();
    expect(invokeSaveSftpWorkspace).toHaveBeenCalledWith('latest');
  });

  it('clearing discards a staged snapshot', async () => {
    stageSftpWorkspace('stale');
    await clearSftpWorkspace();
    await flushSftpWorkspace();
    expect(invokeClearSftpWorkspace).toHaveBeenCalledOnce();
    expect(invokeSaveSftpWorkspace).not.toHaveBeenCalled();
  });
});

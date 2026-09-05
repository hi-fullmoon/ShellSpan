import { describe, expect, it, vi } from 'vitest';
import { listAllAiSessions } from '../session-list';
import type { AiSessionSummaryPage } from '../session-adapter';

describe('session pagination', () => {
  it('stops fetching when the caller changes workspace during a page request', async () => {
    let resolve!: (page: AiSessionSummaryPage) => void;
    let current = true;
    const list = vi.fn(() => new Promise<AiSessionSummaryPage>(done => { resolve = done; }));
    const loading = listAllAiSessions({ list }, { limit: 100 }, () => current);
    current = false;
    resolve({ sessions: [], nextCursor: 'next-page' });
    expect(await loading).toBeNull();
    expect(list).toHaveBeenCalledOnce();
  });

  it('rejects a repeated cursor instead of requesting pages indefinitely', async () => {
    const list = vi.fn(async () => ({ sessions: [], nextCursor: 'same-page' }));
    await expect(listAllAiSessions({ list }, { limit: 100 }, () => true)).rejects.toThrow('repeated cursor');
    expect(list).toHaveBeenCalledTimes(2);
  });
});

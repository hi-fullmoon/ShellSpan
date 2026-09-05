import { describe, expect, it } from 'vitest';

import { normalizeAiSessionError, sessionArchiveErrorMessage } from '@/lib/ai/session-error';
import { initI18n, t } from '@/locales';

describe('normalizeAiSessionError', () => {
  it.each(['AGENT_SESSION_ARCHIVE_BUSY', 'a running Agent Session cannot be archived', 'only an ended Agent Session can be archived'])('localizes archive rejection %s', async message => {
    await initI18n('zh-CN');
    expect(sessionArchiveErrorMessage(new Error(message), t)).toContain('请先停止会话或等待处理完成后再归档');
  });

  it('gives archive failures an actionable message in the selected language', async () => {
    await initI18n('en-US');
    expect(sessionArchiveErrorMessage('disk failure', t)).toBe('Could not archive the session. Refresh the list and try again.');
  });
  it.each([
    ['API key is unauthorized', 'auth', true],
    ['HTTP 429 too many requests', 'rateLimit', true],
    ['Network disconnected', 'offline', true],
    ['Session is already busy', 'conflict', true],
    ['Request cancelled', 'cancelled', false],
    ['Terminal session ended', 'terminal', false],
    ['Unexpected adapter failure', 'unknown', true],
  ] as const)('normalizes %s', (message, kind, retryable) => {
    expect(normalizeAiSessionError(new Error(message))).toEqual({ kind, message, retryable });
  });

  it('preserves the current Runtime revision on a recognizable conflict', () => {
    expect(normalizeAiSessionError(
      new Error('Agent Runtime revision conflict: expected revision 7, current revision 9'),
    )).toMatchObject({ kind: 'conflict', retryable: true, currentRevision: 9 });
  });
});

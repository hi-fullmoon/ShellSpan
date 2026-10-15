import { describe, expect, it, vi } from 'vitest';
import { belongsToAiWorkspace, isTopLevelAiSession, listAllAiSessions } from '../session-list';
import type { AiSessionSummary, AiSessionSummaryPage } from '../session-adapter';

describe('session pagination', () => {
  it('isolates Terminal and Focus history and restoration for the same terminal', () => {
    const terminal = { id: 'agent-local-session-task' };
    const focus = { id: 'focus-agent-local-session-task' };
    expect(belongsToAiWorkspace(terminal, 'terminal', false)).toBe(true);
    expect(belongsToAiWorkspace(focus, 'terminal', false)).toBe(false);
    expect(belongsToAiWorkspace(terminal, 'terminal', true)).toBe(false);
    expect(belongsToAiWorkspace(focus, 'terminal', true)).toBe(true);
    expect(belongsToAiWorkspace({ id: 'ask-workbench-task' }, 'workbench', false)).toBe(true);
    const child = { id: 'session-child', parentSessionId: focus.id };
    const nested = { id: 'session-nested', parentSessionId: child.id };
    expect(belongsToAiWorkspace(nested, 'terminal', false, [focus, child, nested])).toBe(false);
    expect(belongsToAiWorkspace(nested, 'terminal', true, [focus, child, nested])).toBe(true);
    expect(belongsToAiWorkspace(child, 'terminal', false)).toBe(false);
    expect(belongsToAiWorkspace(nested, 'terminal', false)).toBe(false);
  });
  it('hides an owned child but promotes it when the parent is absent', () => {
    const parent: AiSessionSummary = {
      id: 'parent', kind: 'agent', title: 'Parent', updatedAt: '2026-09-18T00:00:00Z',
      status: 'idle', scopeKey: 'scope', archived: false,
    };
    const child: AiSessionSummary = {
      ...parent,
      id: 'child',
      title: 'Child',
      parentSessionId: parent.id,
      subagent: { descriptorId: 'descriptor', role: 'explorer', continuable: false, depth: 1 },
    };

    expect(isTopLevelAiSession(child, [parent, child])).toBe(false);
    expect(isTopLevelAiSession(child, [child])).toBe(true);
  });

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

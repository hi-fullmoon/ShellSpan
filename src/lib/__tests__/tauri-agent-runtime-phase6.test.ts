import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
  invokeMutateAgentRuntimeInbox,
  invokeRenameAgentRuntimeSession,
} from '@/lib/tauri';

beforeEach(() => invoke.mockReset().mockResolvedValue({}));

describe('Phase 6 Agent Runtime Tauri wrappers', () => {
  it('forwards the complete mutation contract without flattening revision or operation id', async () => {
    const input = {
      sessionId: 'session-1',
      expectedRevision: 8,
      clientOperationId: 'mutation-1',
      mutation: { type: 'reorder' as const, lane: 'nextTurn' as const, orderedItemIds: ['b', 'a'] },
    };
    await invokeMutateAgentRuntimeInbox(input);
    expect(invoke).toHaveBeenCalledWith('agent_runtime_mutate_inbox', { input });
  });

  it('forwards rename as one versioned Runtime input', async () => {
    const input = {
      sessionId: 'session-1',
      expectedRevision: 9,
      clientOperationId: 'rename-1',
      title: 'Committed title',
    };
    await invokeRenameAgentRuntimeSession(input);
    expect(invoke).toHaveBeenCalledWith('agent_runtime_rename_session', { input });
  });
});


it('forwards identity-only queue steer on the existing mutateInbox command', async () => {
  const input = { sessionId: 'session-1', expectedRevision: 8, clientOperationId: 'steer-1', mutation: { type: 'steer' as const, itemId: 'queued-original' } };
  await invokeMutateAgentRuntimeInbox(input);
  expect(invoke).toHaveBeenCalledWith('agent_runtime_mutate_inbox', { input });
});

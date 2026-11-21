import { describe, expect, it } from 'vitest';

import type { AiToolNode } from '@/lib/ai/conversation-node';
import type { AiSessionSummary, AiSessionView } from '@/lib/ai/session-adapter';
import {
  buildSubagentLineage,
  correlateSubagentToolSessions,
  extractSubagentToolSummary,
  isSubagentDelegationTool,
  isSubagentTool,
  subagentToolAction,
} from '@/lib/ai/subagent-lineage';
import type { AgentActivityNode, AgentSubagentRole } from '@/types/agent-session';

function makeSummary(
  id: string,
  overrides: Partial<AiSessionSummary> = {},
): AiSessionSummary {
  return {
    id,
    kind: 'agent',
    title: `Session ${id}`,
    updatedAt: '2026-11-20T00:00:00.000Z',
    status: 'completed',
    scopeKey: 'workbench-ai',
    archived: false,
    ...overrides,
  };
}

function makeView(
  summary: AiSessionSummary,
  overrides: Partial<AiSessionView> = {},
): AiSessionView {
  return {
    summary,
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: summary.id,
          taskId: 'task-1',
          goal: summary.title,
          executionSurface: 'direct',
          createdAtUnixMs: 1_000,
          ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
          ...(summary.subagent
            ? {
                subagent: {
                  descriptorId: summary.subagent.descriptorId,
                  parentTaskId: 'task-1',
                  role: summary.subagent.role as AgentSubagentRole,
                  continuable: summary.subagent.continuable,
                  depth: summary.subagent.depth ?? 1,
                  inheritance: { mode: 'safePrefix' as const },
                  capabilityScope: { toolNames: [], effects: [], targetIds: [] },
                  targetScope: [],
                  budget: { maxTurns: 4, timeoutMs: 60_000 },
                },
              }
            : {}),
        },
        status: summary.status,
        ended: summary.status === 'completed' || summary.status === 'failed' || summary.status === 'cancelled',
        archived: false,
        eventCount: 1,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: {
          kind: 'idle',
          status: 'none',
          summary: '',
          lastCommittedSeq: 1,
        },
      },
    },
    nodes: [],
    activityNodes: [],
    inbox: [],
    pendingApproval: null,
    status: summary.status,
    error: null,
    throughSeq: 1,
    canLoadOlder: false,
    ...overrides,
  };
}

function makeSubagentTool(
  overrides: Partial<AiToolNode> = {},
): AiToolNode {
  return {
    kind: 'tool',
    key: 'tool:1',
    sourceKind: 'agent',
    sessionId: 'root',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 10,
    lastSeq: 12,
    timestamp: '2026-11-20T00:00:00.000Z',
    callId: 'call-1',
    name: 'spawn_continuable_agent',
    nativeName: 'spawn_continuable_agent',
    title: 'Agent orchestration',
    summary: '',
    state: 'running',
    effect: 'readOnly',
    durationMs: null,
    detailRef: { kind: 'agentTool', sessionId: 'root', callId: 'call-1' },
    evidenceRefs: [],
    input: {
      goal: 'Inspect nginx configuration',
      role: 'explorer',
      inheritanceMode: 'safePrefix',
      targetIds: ['workbench-ai'],
    },
    output: null,
    error: null,
    target: null,
    idempotency: null,
    approval: null,
    ...overrides,
  };
}

describe('subagent-lineage', () => {
  it('recognizes only real child subagent orchestration tool names', () => {
    expect(isSubagentTool('spawn_one_shot_agent')).toBe(true);
    expect(isSubagentTool('spawn_continuable_agent')).toBe(true);
    expect(isSubagentTool('send_child_input')).toBe(true);
    expect(isSubagentTool('retry_child_agent')).toBe(true);
    expect(isSubagentTool('inspect_child_agent')).toBe(true);
    expect(isSubagentTool('cancel_child_agent')).toBe(true);
    expect(isSubagentTool('wrapped.spawn_continuable_agent', 'spawn_continuable_agent')).toBe(true);
    expect(isSubagentTool('provider.future_tool', null)).toBe(false);
    expect(isSubagentTool('fleet_start')).toBe(false);

    expect(subagentToolAction('spawn_one_shot_agent')).toBe('spawn');
    expect(subagentToolAction('spawn_continuable_agent')).toBe('spawn');
    expect(subagentToolAction('send_child_input')).toBe('input');
    expect(subagentToolAction('retry_child_agent')).toBe('retry');
    expect(subagentToolAction('inspect_child_agent')).toBe('inspect');
    expect(subagentToolAction('cancel_child_agent')).toBe('cancel');

    expect(isSubagentDelegationTool('spawn_one_shot_agent')).toBe(true);
    expect(isSubagentDelegationTool('spawn_continuable_agent')).toBe(true);
    expect(isSubagentDelegationTool('send_child_input')).toBe(true);
    expect(isSubagentDelegationTool('retry_child_agent')).toBe(true);
    expect(isSubagentDelegationTool('inspect_child_agent')).toBe(false);
    expect(isSubagentDelegationTool('cancel_child_agent')).toBe(false);
    expect(isSubagentDelegationTool('fleet_start')).toBe(false);
  });

  it('builds root, parent, trail, entries, currentChildren, and goal-based fallback titles', () => {
    const root = makeSummary('root', { title: 'Root task', status: 'running' });
    const child = makeSummary('child', {
      title: 'Inspect files',
      status: 'running',
      parentSessionId: 'root',
      updatedAt: '2026-11-20T00:00:01.000Z',
      subagent: { descriptorId: 'd-child', role: 'explorer', continuable: true, depth: 1 },
    });
    const grandchild = makeSummary('grandchild', {
      title: 'Verify syntax',
      status: 'waiting',
      parentSessionId: 'child',
      updatedAt: '2026-11-20T00:00:02.000Z',
      subagent: { descriptorId: 'd-grandchild', role: 'verifier', continuable: false, depth: 2 },
    });

    const childView = makeView(child, {
      subagents: [{
        sessionId: 'grandchild',
        parentSessionId: 'child',
        descriptorId: 'd-grandchild',
        role: 'verifier',
        continuable: false,
        depth: 2,
        status: 'waiting',
      }, {
        sessionId: 'fresh-child',
        parentSessionId: 'child',
        descriptorId: 'd-fresh',
        role: 'diagnostician',
        continuable: true,
        depth: 2,
        status: 'running',
      }],
    });

    const lineage = buildSubagentLineage(
      childView,
      [root, child, grandchild],
      new Map([['fresh-child', 'Diagnose service restart loop in nginx logs']]),
    );
    expect(lineage).not.toBeNull();
    expect(lineage!.root.id).toBe('root');
    expect(lineage!.parent?.id).toBe('root');
    expect(lineage!.trail.map((item) => item.id)).toEqual(['root', 'child']);
    expect(lineage!.entries.map((entry) => [entry.summary.id, entry.depth])).toEqual([
      ['child', 1],
      ['fresh-child', 2],
      ['grandchild', 2],
    ]);
    expect(lineage!.currentChildren.map((entry) => [entry.summary.id, entry.depth])).toEqual([
      ['fresh-child', 1],
      ['grandchild', 1],
    ]);
    expect(lineage!.byId.get('fresh-child')?.title).toBe('Diagnose service restart loop in nginx logs');
  });

  it('handles orphaned subagent sessions with null parent and single-item trail', () => {
    const orphan = makeSummary('orphan', {
      title: 'Orphaned child',
      status: 'completed',
      parentSessionId: 'missing-parent',
      subagent: { descriptorId: 'd-orphan', role: 'operator', continuable: false, depth: 1 },
    });
    const lineage = buildSubagentLineage(makeView(orphan), []);
    expect(lineage).not.toBeNull();
    expect(lineage!.root.id).toBe('orphan');
    expect(lineage!.parent).toBeNull();
    expect(lineage!.trail.map((item) => item.id)).toEqual(['orphan']);
    expect(lineage!.currentChildren).toEqual([]);
  });

  it('correlates live spawns via activityNodes and settled spawns via output', () => {
    const settledSpawn = makeSubagentTool({
      key: 'tool:settled',
      firstSeq: 5,
      state: 'succeeded',
      durationMs: 1200,
      input: { goal: 'Check ports', role: 'explorer' },
      output: {
        childSessionId: 'child-settled',
        status: 'idle',
        continuable: true,
        partial: false,
        usage: { toolCalls: 4, elapsedMs: 1200 },
        plan: [{ id: 's1', title: 'Run ss -tlnp', status: 'completed' }],
      },
    });
    const liveSpawn = makeSubagentTool({
      key: 'tool:live',
      firstSeq: 20,
      state: 'running',
      input: { goal: 'Inspect nginx configuration\nCheck upstream blocks', role: 'diagnostician' },
      output: null,
    });
    const inputCall = makeSubagentTool({
      key: 'tool:input',
      name: 'send_child_input',
      nativeName: 'send_child_input',
      firstSeq: 30,
      state: 'running',
      input: { childSessionId: 'child-settled', content: 'Also check TLS expiry' },
      output: null,
    });
    const activityNodes: AgentActivityNode[] = [{
      key: 'activity:subagent:d-live',
      kind: 'subagent',
      sessionId: 'root',
      turnId: 'turn-1',
      stepId: 'step-2',
      requestId: null,
      firstSeq: 21,
      lastSeq: 21,
      timestamp: '2026-11-20T00:00:01.000Z',
      status: 'started',
      label: 'diagnostician',
      detail: 'child-live',
      eventTypes: ['subagent/descriptor'],
      eventSeqs: [21],
      records: [],
      data: {
        descriptorId: 'd-live',
        childSessionId: 'child-live',
        role: 'diagnostician',
        continuable: true,
      },
    }];

    const correlation = correlateSubagentToolSessions(
      [settledSpawn, liveSpawn, inputCall],
      activityNodes,
      [{
        sessionId: 'child-live',
        parentSessionId: 'root',
        descriptorId: 'd-live',
        role: 'diagnostician',
        continuable: true,
        depth: 1,
        status: 'waiting',
      }],
      [],
    );

    expect(correlation.toolChildSessionIds.get('tool:settled')).toBe('child-settled');
    expect(correlation.toolChildSessionIds.get('tool:live')).toBe('child-live');
    expect(correlation.toolChildSessionIds.get('tool:input')).toBe('child-settled');
    expect(correlation.goalByChildId.get('child-live')).toBe('Inspect nginx configuration\nCheck upstream blocks');

    const root = makeSummary('root', { status: 'running' });
    const lineage = buildSubagentLineage(
      makeView(root, {
        subagents: [{
          sessionId: 'child-settled',
          parentSessionId: 'root',
          descriptorId: 'd-settled',
          role: 'explorer',
          continuable: true,
          depth: 1,
          status: 'running',
        }, {
          sessionId: 'child-live',
          parentSessionId: 'root',
          descriptorId: 'd-live',
          role: 'diagnostician',
          continuable: true,
          depth: 1,
          status: 'waiting',
        }],
      }),
      [root, makeSummary('child-settled', {
        title: 'Check ports',
        status: 'running',
        parentSessionId: 'root',
        subagent: { descriptorId: 'd-settled', role: 'explorer', continuable: true, depth: 1 },
      })],
      correlation.goalByChildId,
    );

    const settledSummary = extractSubagentToolSummary(settledSpawn, lineage, correlation.toolChildSessionIds);
    expect(settledSummary.status).toBe('completed');
    expect(settledSummary.toolCallCount).toBe(4);
    expect(settledSummary.plan).toEqual([{ id: 's1', title: 'Run ss -tlnp', status: 'completed' }]);

    const liveSummary = extractSubagentToolSummary(liveSpawn, lineage, correlation.toolChildSessionIds);
    expect(liveSummary.childSessionId).toBe('child-live');
    expect(liveSummary.title).toBe('Inspect nginx configuration');
    expect(liveSummary.status).toBe('waiting');
    expect(liveSummary.role).toBe('diagnostician');

    const inputSummary = extractSubagentToolSummary(inputCall, lineage, correlation.toolChildSessionIds);
    expect(inputSummary.action).toBe('input');
    expect(inputSummary.title).toBe('Check ports');
    expect(inputSummary.inputContent).toBe('Also check TLS expiry');
  });

  it('marks uncertain subagent tools as uncertain instead of completed and preserves errors', () => {
    const uncertainTool = makeSubagentTool({
      key: 'tool:uncertain',
      state: 'uncertain',
      summary: 'Timed out before subagent confirmation',
      error: 'Execution status unknown',
      output: null,
    });
    const summary = extractSubagentToolSummary(uncertainTool, null, new Map());
    expect(summary.status).toBe('uncertain');
    expect(summary.errorMessage).toBe('Execution status unknown');
  });

  it('preserves live running/waiting status for resumed continuable children and clears stale running on settled one-shot children', () => {
    const root = makeSummary('root', { status: 'running' });
    const liveContinuable = makeSummary('child-continuable', {
      title: 'Continuable explorer',
      status: 'waiting',
      parentSessionId: 'root',
      subagent: { descriptorId: 'd-1', role: 'explorer', continuable: true, depth: 1 },
    });
    const settledOneShot = makeSummary('child-oneshot', {
      title: 'One-shot verifier',
      status: 'running',
      parentSessionId: 'root',
      subagent: { descriptorId: 'd-2', role: 'verifier', continuable: false, depth: 1 },
    });

    const lineage = buildSubagentLineage(
      makeView(root, {
        subagents: [{
          sessionId: 'child-continuable',
          parentSessionId: 'root',
          descriptorId: 'd-1',
          role: 'explorer',
          continuable: true,
          depth: 1,
          status: 'completed',
        }, {
          sessionId: 'child-oneshot',
          parentSessionId: 'root',
          descriptorId: 'd-2',
          role: 'verifier',
          continuable: false,
          depth: 1,
          status: 'completed',
        }],
      }),
      [root, liveContinuable, settledOneShot],
    );

    expect(lineage?.entryById.get('child-continuable')?.status).toBe('waiting');
    expect(lineage?.entryById.get('child-oneshot')?.status).toBe('completed');
  });

  it('marks succeeded inspect_child_agent as completed even when snapshot reports a failed child', () => {
    const inspectTool = makeSubagentTool({
      key: 'tool:inspect',
      name: 'inspect_child_agent',
      nativeName: 'inspect_child_agent',
      state: 'succeeded',
      summary: 'Child child-failed is Failed',
      input: { childSessionId: 'child-failed' },
      output: {
        snapshot: {
          status: 'failed',
          header: {
            sessionId: 'child-failed',
            goal: 'Verify nginx upstream status\nAdditional details',
            subagent: {
              role: 'operator',
              continuable: false,
            },
          },
        },
      },
    });
    const summary = extractSubagentToolSummary(inspectTool, null, new Map());
    expect(summary.action).toBe('inspect');
    expect(summary.status).toBe('completed');
    expect(summary.role).toBe('operator');
    expect(summary.title).toBe('Verify nginx upstream status');
  });

  it('returns stable empty correlation references when no subagent tools are present', () => {
    const regularTool = makeSubagentTool({
      key: 'tool:regular',
      name: 'run_terminal_command',
      nativeName: 'run_terminal_command',
    });
    const first = correlateSubagentToolSessions([regularTool]);
    const second = correlateSubagentToolSessions([]);
    expect(first).toBe(second);
    expect(first.toolChildSessionIds.size).toBe(0);
    expect(first.goalByChildId.size).toBe(0);
  });
});

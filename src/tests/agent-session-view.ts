import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import type { AgentSessionBaselineScenario } from './fixtures/agent-session-baseline';

export function agentSessionBaselineView(scenario: AgentSessionBaselineScenario): AiSessionView {
  const last = scenario.events[scenario.events.length - 1];
  const first = scenario.events[0];
  const ended = scenario.status !== 'running';
  return {
    summary: {
      id: scenario.sessionId,
      kind: 'agent',
      title: scenario.title,
      updatedAt: new Date(last?.timeUnixMs ?? first?.timeUnixMs ?? 0).toISOString(),
      status: scenario.status,
      scopeKey: 'baseline-workbench',
      archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: scenario.sessionId,
          taskId: scenario.taskId,
          goal: scenario.title,
          target: scenario.events.find((event) => event.type === 'session/created')?.data.target,
          permissionMode: scenario.modelInput.permission,
          executionSurface: scenario.events.find((event) => event.type === 'session/created')?.data.executionSurface ?? 'direct',
          createdAtUnixMs: first?.timeUnixMs ?? 0,
        },
        status: scenario.status,
        ended,
        archived: false,
        eventCount: scenario.events.length,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: {
          kind: ended ? 'terminal' : 'openModelRequest',
          status: 'none',
          summary: 'Agent Session deterministic fixture',
          lastCommittedSeq: last?.seq ?? 0,
        },
      },
    },
    nodes: projectAgentChatNodes(scenario.events),
    activityNodes: projectAgentActivity(scenario.events).nodes,
    inbox: [],
    pendingApproval: null,
    status: scenario.status,
    error: null,
    throughSeq: last?.seq ?? null,
    canLoadOlder: Boolean(scenario.pages?.older.length),
  };
}

import type {
  AgentApprovalReference,
  AgentRisk,
  AgentToolApprovalSnapshot,
} from '@/types/agent-approval';
import type {
  AgentConversationToolItem,
  AgentSessionPermissionMode,
} from '@/types/agent-session';

function riskForEffect(effect: AgentConversationToolItem['effect']): AgentRisk {
  if (effect === 'destructive') return 'destructive';
  if (effect === 'readOnly' || effect === 'none') return 'readOnly';
  return 'stateChange';
}

function commandForTool(tool: AgentConversationToolItem): string {
  if (tool.arguments && typeof tool.arguments === 'object') {
    const command = (tool.arguments as Readonly<Record<string, unknown>>).command;
    if (typeof command === 'string' && command.trim()) return command;
  }
  try {
    const rendered = JSON.stringify(tool.arguments, null, 2);
    return typeof rendered === 'string' ? rendered.slice(0, 8_192) || tool.name : tool.name;
  } catch {
    return tool.name;
  }
}

function explanationForTool(tool: AgentConversationToolItem): string {
  if (tool.arguments && typeof tool.arguments === 'object') {
    const explanation = (tool.arguments as Readonly<Record<string, unknown>>).explanation;
    if (typeof explanation === 'string' && explanation.trim()) return explanation;
  }
  return tool.approvalPrompt ?? tool.summary ?? `Approve ${tool.title} on the frozen target.`;
}

function outputForTool(tool: AgentConversationToolItem): string {
  if (tool.resultSummary) return tool.resultSummary;
  if (typeof tool.result === 'string') return tool.result;
  try {
    return JSON.stringify(tool.result, null, 2) ?? '';
  } catch {
    return String(tool.result ?? '');
  }
}

export function agentToolApprovalReference(
  sessionId: string | undefined,
  tool: AgentConversationToolItem,
): AgentApprovalReference | undefined {
  if (!sessionId || !tool.turnId || !tool.stepId || !tool.approvalRequestId || !tool.approvalId) {
    return undefined;
  }
  return {
    sessionId,
    turnId: tool.turnId,
    stepId: tool.stepId,
    requestId: tool.approvalRequestId,
    callId: tool.callId,
    approvalId: tool.approvalId,
  };
}

export function agentToolApprovalSnapshot(
  sessionId: string | undefined,
  tool: AgentConversationToolItem,
  _permissionMode: AgentSessionPermissionMode | undefined,
): AgentToolApprovalSnapshot | undefined {
  const approval = agentToolApprovalReference(sessionId, tool);
  if (tool.status === 'awaitingApproval' && !approval) return undefined;
  const target = tool.target;
  if (!target) return undefined;
  return {
    toolCall: {
      requestId: tool.approvalRequestId ?? '',
      callId: tool.callId,
      name: tool.name,
      command: commandForTool(tool),
      explanation: explanationForTool(tool),
      target: {
        kind: target.kind,
        sessionId: target.sessionId,
        profileId: target.profileId,
        host: target.host ?? 'local',
        port: target.port ?? 0,
        username: target.username ?? 'local',
      },
    },
    riskAssessment: { risk: riskForEffect(tool.effect) },
    status: tool.status,
    approval,
    ...(tool.result !== undefined || tool.resultSummary
      ? { result: { output: outputForTool(tool) } }
      : {}),
  };
}

import type { AiConversationNode, AiToolNode, AiTurnProcessChildNode } from './conversation-node';

function resultReadIdentity(node: AiToolNode): string | null {
  if (node.name !== 'read_tool_result' || node.effect !== 'readOnly' || !node.turnId) return null;
  if (typeof node.input !== 'object' || node.input === null || Array.isArray(node.input)) return null;
  const input = node.input as Record<string, unknown>;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof input.artifactId !== 'string' || !input.artifactId
    || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (node.state === 'succeeded') {
    if (typeof node.output !== 'object' || node.output === null || Array.isArray(node.output)) return null;
    const output = node.output as Record<string, unknown>;
    if (output.artifactRef !== input.artifactId || output.offset !== offset
      || typeof output.nextOffset !== 'number' || !Number.isSafeInteger(output.nextOffset)
      || output.nextOffset < offset) return null;
  }
  return JSON.stringify([node.sessionId, node.turnId, input.artifactId, offset]);
}

/** Derive presentation metadata from committed reads without changing failure evidence. */
export function markRecoveredToolReads(children: readonly AiTurnProcessChildNode[]): AiTurnProcessChildNode[] {
  const pending = new Map<string, AiToolNode[]>();
  const recovered = new Map<string, string>();
  const tools = children.filter((child): child is AiToolNode => child.kind === 'tool')
    .sort((left, right) => left.lastSeq - right.lastSeq);
  for (const tool of tools) {
    if (tool.state !== 'failed' && tool.state !== 'succeeded') continue;
    const identity = resultReadIdentity(tool);
    if (!identity) continue;
    if (tool.state === 'failed') {
      const failures = pending.get(identity) ?? [];
      failures.push(tool);
      pending.set(identity, failures);
    } else {
      for (const failure of pending.get(identity) ?? []) {
        // A concurrent read started before the failure is not a recovery attempt.
        if (tool.firstSeq > failure.lastSeq) recovered.set(failure.key, tool.key);
      }
      pending.set(identity, (pending.get(identity) ?? []).filter(failure => !recovered.has(failure.key)));
    }
  }
  return children.map((child) => child.kind === 'tool' && recovered.has(child.key)
    ? { ...child, recoveredByToolKey: recovered.get(child.key) }
    : child);
}

type ToolIdentity = Pick<AiToolNode, 'sessionId'> & (
  | Readonly<{ nodeKey: string }>
  | Pick<AiToolNode, 'turnId' | 'stepId' | 'callId'>
);

/** Resolve the same scoped tool for approval metadata and parameter inspection. */
export function findConversationTool(
  nodes: readonly AiConversationNode[],
  identity: ToolIdentity,
): AiToolNode | undefined {
  for (const node of nodes) {
    if (node.kind === 'turnProcess') {
      const tool = findConversationTool(node.children, identity);
      if (tool) return tool;
    } else if (node.kind === 'tool'
      && node.sessionId === identity.sessionId
      && ('nodeKey' in identity
        ? node.key === identity.nodeKey
        : node.turnId === identity.turnId
          && node.stepId === identity.stepId
          && node.callId === identity.callId)) {
      return node;
    }
  }
  return undefined;
}

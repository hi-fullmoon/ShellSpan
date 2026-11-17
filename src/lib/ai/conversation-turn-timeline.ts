import type {
  AiAssistantMessageNode,
  AiConversationNode,
  AiTurnProcessChildNode,
  AiTurnProcessNode,
  AiUserMessageNode,
} from './conversation-node';

/** Keep one turn's accounting, but expose each accepted correction at its boundary. */
export function conversationTurnTimeline(
  users: readonly AiUserMessageNode[],
  process: AiTurnProcessNode,
  outputs: readonly AiAssistantMessageNode[],
): readonly AiConversationNode[] {
  const steering = users.filter(user => user.inputKind === 'steer');
  const initial = users.filter(user => user.inputKind !== 'steer');
  if (steering.length === 0) return [...initial, process, ...outputs];

  const nodes: AiConversationNode[] = [...initial];
  const segments: AiTurnProcessChildNode[][] = Array.from({ length: steering.length + 1 }, () => []);
  // Closing text can precede a correction that arrived before the turn finished.
  // In that case it belongs to the earlier segment, not below the new input.
  const outputKeys = new Set(outputs.map(output => output.key));
  for (const child of [...process.children, ...outputs]) {
    const next = steering.findIndex(user => user.firstSeq > child.firstSeq);
    segments[next < 0 ? steering.length : next].push(child);
  }
  for (let index = 0; index < segments.length; index += 1) {
    const user = steering[index - 1];
    const next = steering[index];
    if (user) nodes.push(user);
    const children = segments[index];
    const processChildren = children.filter(child => !outputKeys.has(child.key));
    nodes.push({
      ...process,
      key: user ? `${process.key}:after:${user.messageId}` : process.key,
      firstSeq: user?.firstSeq ?? process.firstSeq,
      lastSeq: next ? Math.max(next.firstSeq - 1, ...children.map(child => child.lastSeq)) : process.lastSeq,
      timestamp: user?.timestamp ?? process.timestamp,
      status: next ? 'completed' : process.status,
      hasStartBoundary: !user && process.hasStartBoundary,
      hasEndBoundary: !next && process.hasEndBoundary,
      hasInterleavedInput: true,
      answerGeneration: processChildren[processChildren.length - 1]?.key ?? user?.key ?? process.key,
      children: processChildren,
      childKeys: processChildren.map(child => child.key),
    });
    for (const output of children) {
      if (output.kind === 'assistantMessage' && outputKeys.has(output.key)) {
        nodes.push(next && output.hasTurnTail ? { ...output, hasTurnTail: false } : output);
      }
    }
  }
  return nodes;
}

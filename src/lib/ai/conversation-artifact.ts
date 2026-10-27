import type { AiArtifactNode, AiConversationNode } from './conversation-node';

const RUNTIME_ARTIFACT_KINDS = new Set([
  'tool-result', 'model-tool-result', 'context-budget', 'context-budget-checkpoint',
  'compaction-attempt', 'structured-compaction', 'task-budget-progress', 'task-budget-checkpoint',
]);

export function isRuntimeArtifact(node: AiArtifactNode): boolean {
  return RUNTIME_ARTIFACT_KINDS.has(node.artifactKind);
}

/** Group presentation only; original artifacts and audit events remain unchanged. */
export function groupConversationArtifacts(artifacts: readonly AiArtifactNode[]): AiConversationNode[] {
  const internal = artifacts.filter(isRuntimeArtifact);
  if (internal.length === 0) return [...artifacts];
  const first = internal[0];
  return artifacts.flatMap((artifact): AiConversationNode[] => {
    if (!isRuntimeArtifact(artifact)) return [artifact];
    if (artifact !== first) return [];
    return [{
      kind: 'runtimeArtifacts', key: `runtime-artifacts:${first.sessionId}:${first.turnId ?? 'unscoped'}`,
      sourceKind: first.sourceKind, sessionId: first.sessionId, turnId: first.turnId, stepId: null,
      firstSeq: first.firstSeq, lastSeq: internal.reduce((latest, item) => Math.max(latest, item.lastSeq), first.lastSeq),
      timestamp: first.timestamp, artifacts: internal,
    }];
  });
}

export function conversationArtifacts(nodes: readonly AiConversationNode[]): AiArtifactNode[] {
  return nodes.flatMap(node => node.kind === 'artifact' ? [node]
    : node.kind === 'runtimeArtifacts' ? [...node.artifacts]
      : node.kind === 'turnProcess' ? conversationArtifacts(node.children) : []);
}

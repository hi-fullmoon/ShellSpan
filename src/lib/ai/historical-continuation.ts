import { terminalLoginScopeKey } from './terminal-login-scope';
import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import type { AiConversationNode } from './conversation-node';
import type { AiSessionAdapter, AiSessionView } from './session-adapter';

/** An old terminal target cannot be rebound; only a connected matching login may receive a fresh session. */
export function canContinueHistoricalConversation(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!snapshot || !terminal || terminal.status !== 'connected' || snapshot.header.subagent) return false;
  const target = snapshot.header.target;
  if (!target || target.sessionId === terminal.sessionId) return false;
  const previousLogin = terminalLoginScopeKey(target);
  return previousLogin !== null && previousLogin === terminalLoginScopeKey(terminal);
}

function historicalNode(node: AiConversationNode): AiConversationNode {
  const key = `history:${node.sessionId}:${node.key}`;
  if (node.kind !== 'turnProcess') return { ...node, key };
  const children = node.children.map((child) => historicalNode(child));
  return {
    ...node,
    key,
    childKeys: children.map((child) => child.key),
    children: children as typeof node.children,
  };
}

/** Keep every durable source node (including tools and artifacts) before new output. */
export function withHistoricalConversation(
  current: AiSessionView,
  sources: readonly AiSessionView[],
): AiSessionView {
  if (sources.length === 0) return current;
  return {
    ...current,
    nodes: [...sources.flatMap((source) => source.nodes.map(historicalNode)), ...current.nodes],
  };
}

/** Follow durable continuation links back to the original transcript, oldest first. */
export async function loadHistoricalSources(
  adapter: Pick<AiSessionAdapter<'agent'>, 'open'>,
  current: AiSessionView,
): Promise<readonly AiSessionView[]> {
  const visited = new Set([current.summary.id]);
  const sources: AiSessionView[] = [];
  let sourceId = current.snapshot?.value.header.continuedFromSessionId;
  while (sourceId) {
    if (visited.has(sourceId)) throw new Error('Continuation history contains a cycle');
    visited.add(sourceId);
    const source = await adapter.open(sourceId);
    sources.unshift(source);
    sourceId = source.snapshot.value.header.continuedFromSessionId;
  }
  return sources;
}

import type {
  AiConversationNode,
  AiConversationNodeOf,
  AiTurnProcessChildNode,
} from '@/lib/ai/conversation-node';
import { isSubagentDelegationTool, subagentToolAction } from '@/lib/ai/subagent-lineage';
import { classifyAiTool } from './ai-tool-presentation';

export interface AiGroupedTurnProcessEntry {
  readonly node: AiTurnProcessChildNode;
  readonly groupedTools?: readonly AiConversationNodeOf<'tool'>[];
}

export interface AiConversationRow {
  readonly node: AiConversationNode;
  readonly process?: AiConversationNodeOf<'turnProcess'>;
  readonly processMember?: boolean;
  readonly hasResponse?: boolean;
  readonly groupedTools?: readonly AiConversationNodeOf<'tool'>[];
  readonly processChildKeys?: readonly string[];
}

export function isGroupableReadOnlyTool(node: AiConversationNode): node is AiConversationNodeOf<'tool'> {
  if (node.kind !== 'tool') return false;
  if (node.state !== 'succeeded') return false;
  if (node.recoveredByToolKey) return false;
  if (isSubagentDelegationTool(node.name, node.nativeName) || subagentToolAction(node.name, node.nativeName) !== null) {
    return false;
  }
  const variant = classifyAiTool(node.name, node.nativeName);
  return variant === 'read' || variant === 'search';
}

const groupedChildrenCache = new WeakMap<readonly AiTurnProcessChildNode[], AiGroupedTurnProcessEntry[]>();
const processChildKeysCache = new WeakMap<readonly AiGroupedTurnProcessEntry[], readonly string[]>();

export function groupTurnProcessChildren(
  children: readonly AiTurnProcessChildNode[],
): AiGroupedTurnProcessEntry[] {
  const cached = groupedChildrenCache.get(children);
  if (cached) return cached;
  const entries: AiGroupedTurnProcessEntry[] = [];
  let run: AiConversationNodeOf<'tool'>[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      entries.push({ node: run[0], groupedTools: run });
    } else {
      entries.push({ node: run[0] });
    }
    run = [];
  };
  for (const child of children) {
    if (isGroupableReadOnlyTool(child)) {
      run.push(child);
    } else {
      flushRun();
      entries.push({ node: child });
    }
  }
  flushRun();
  groupedChildrenCache.set(children, entries);
  return entries;
}

/** Keep message keys and parents stable when streamed text becomes tool-bearing progress. */
export function conversationRows(nodes: readonly AiConversationNode[]): AiConversationRow[] {
  const rows: AiConversationRow[] = [];
  let process: AiConversationNodeOf<'turnProcess'> | undefined;
  let turnProcesses: AiConversationNodeOf<'turnProcess'>[] = [];
  let controlIndex = -1;
  for (const node of nodes) {
    if (node.kind === 'turnProcess') {
      if (
        turnProcesses.length === 0
        || turnProcesses[0].sessionId !== node.sessionId
        || turnProcesses[0].turnId !== node.turnId
      ) {
        turnProcesses = [node];
      } else {
        turnProcesses.push(node);
      }
      process = node;
      controlIndex = rows.length;
      const entries = groupTurnProcessChildren(node.children);
      let processChildKeys = processChildKeysCache.get(entries);
      if (!processChildKeys) {
        processChildKeys = entries.map((entry) => entry.node.key);
        processChildKeysCache.set(entries, processChildKeys);
      }
      rows.push({
        node,
        process,
        processChildKeys,
      });
      for (const entry of entries) {
        rows.push({
          node: entry.node,
          process,
          processMember: true,
          groupedTools: entry.groupedTools,
        });
      }
    } else {
      if (process && (process.sessionId !== node.sessionId || process.turnId !== node.turnId
        || node.kind === 'userMessage')) {
        if (process.sessionId !== node.sessionId || process.turnId !== node.turnId
          || (node.kind === 'userMessage' && node.inputKind !== 'steer')) {
          turnProcesses = [];
        }
        process = undefined;
      }
      if (node.kind === 'assistantMessage' && process) {
        rows[controlIndex] = { ...rows[controlIndex], hasResponse: true };
      }
      const tailProcess = node.kind === 'turnTail' && process && turnProcesses.length > 1
        ? {
            ...process,
            firstSeq: turnProcesses[0].firstSeq,
            hasStartBoundary: turnProcesses[0].hasStartBoundary,
            children: turnProcesses.flatMap((segment) => segment.children),
            childKeys: turnProcesses.flatMap((segment) => segment.childKeys),
          }
        : process;
      rows.push({
        node,
        process: node.kind === 'assistantMessage'
          ? process
          : node.kind === 'turnTail'
            ? tailProcess
            : undefined,
      });
    }
  }
  return rows;
}

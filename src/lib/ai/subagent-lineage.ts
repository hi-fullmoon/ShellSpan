import type { AiConversationNode, AiToolNode } from './conversation-node';
import type { AiSessionSummary, AiSessionView } from './session-adapter';
import { fallbackSessionTitle } from './session-title';
import type {
  AgentActivityAgent,
  AgentActivityNode,
  AgentSessionPlanStep,
  AgentSessionRuntimeStatus,
} from '@/types/agent-session';

export interface AiSubagentEntry {
  readonly summary: AiSessionSummary;
  readonly parentSessionId?: string;
  readonly role: AgentActivityAgent['role'];
  readonly continuable: boolean;
  readonly status: AgentSessionRuntimeStatus;
  readonly depth: number;
  readonly detail?: string;
}

export interface AiSubagentLineage {
  readonly root: AiSessionSummary;
  readonly current: AiSessionSummary;
  readonly parent: AiSessionSummary | null;
  readonly trail: readonly AiSessionSummary[];
  readonly entries: readonly AiSubagentEntry[];
  readonly currentChildren: readonly AiSubagentEntry[];
  readonly byId: ReadonlyMap<string, AiSessionSummary>;
  readonly entryById: ReadonlyMap<string, AiSubagentEntry>;
}

export type SubagentToolAction = 'spawn' | 'input' | 'retry' | 'inspect' | 'cancel';

export interface SubagentToolPlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: AgentSessionPlanStep['status'];
}

export interface SubagentToolSummary {
  readonly action: SubagentToolAction;
  readonly childSessionId: string | null;
  readonly role: AgentActivityAgent['role'];
  readonly continuable?: boolean;
  readonly title: string;
  readonly goal?: string;
  readonly inputContent?: string;
  readonly status: AgentSessionRuntimeStatus | 'approval' | 'uncertain';
  readonly partial: boolean;
  readonly resultSummary?: string;
  readonly errorMessage?: string;
  readonly plan: readonly SubagentToolPlanStep[];
  readonly toolCallCount: number | null;
  readonly durationMs: number | null;
}

export const SUBAGENT_TOOL_NAMES = new Set([
  'spawn_one_shot_agent',
  'spawn_continuable_agent',
  'send_child_input',
  'retry_child_agent',
  'inspect_child_agent',
  'cancel_child_agent',
]);

type UnknownRecord = Record<string, unknown>;

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[.\-]/gu, '_');
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function firstNonEmptyString(record: UnknownRecord | null, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function firstFiniteNumber(record: UnknownRecord | null, keys: readonly string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function flattenToolNodes(nodes: readonly AiConversationNode[]): readonly AiToolNode[] {
  const tools: AiToolNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'tool') tools.push(node);
    else if (node.kind === 'turnProcess') {
      for (const child of node.children) {
        if (child.kind === 'tool') tools.push(child);
      }
    }
  }
  return tools;
}

function resolveCanonicalSubagentName(name: string, nativeName?: string | null): string | null {
  const normalized = normalizedToolName(name);
  if (SUBAGENT_TOOL_NAMES.has(normalized)) return normalized;
  if (nativeName) {
    const normalizedNative = normalizedToolName(nativeName);
    if (SUBAGENT_TOOL_NAMES.has(normalizedNative)) return normalizedNative;
  }
  return null;
}

export function isSubagentTool(name: string, nativeName?: string | null): boolean {
  return resolveCanonicalSubagentName(name, nativeName) !== null;
}

export function isSubagentDelegationTool(name: string, nativeName?: string | null): boolean {
  const action = subagentToolAction(name, nativeName);
  return action === 'spawn' || action === 'input' || action === 'retry';
}

export function subagentToolAction(name: string, nativeName?: string | null): SubagentToolAction | null {
  const canonical = resolveCanonicalSubagentName(name, nativeName);
  switch (canonical) {
    case 'spawn_one_shot_agent':
    case 'spawn_continuable_agent':
      return 'spawn';
    case 'send_child_input':
      return 'input';
    case 'retry_child_agent':
      return 'retry';
    case 'inspect_child_agent':
      return 'inspect';
    case 'cancel_child_agent':
      return 'cancel';
    default:
      return null;
  }
}

function explicitChildSessionId(node: AiToolNode): string | null {
  const output = asRecord(node.output);
  const input = asRecord(node.input);
  const snapshot = asRecord(output?.snapshot);
  const header = asRecord(snapshot?.header);
  return firstNonEmptyString(output, ['childSessionId'])
    ?? firstNonEmptyString(header, ['sessionId'])
    ?? firstNonEmptyString(input, ['childSessionId'])
    ?? null;
}

function spawnRoleAndContinuable(node: AiToolNode): { role?: string; continuable: boolean } {
  const canonical = resolveCanonicalSubagentName(node.name, node.nativeName);
  const input = asRecord(node.input);
  return {
    role: firstNonEmptyString(input, ['role']),
    continuable: canonical === 'spawn_continuable_agent',
  };
}

const EMPTY_STRING_MAP: ReadonlyMap<string, string> = new Map();
const EMPTY_CORRELATION = {
  toolChildSessionIds: EMPTY_STRING_MAP,
  goalByChildId: EMPTY_STRING_MAP,
} as const;

function mergeSubagentStatus(
  existing: AiSessionSummary,
  activity: AgentActivityAgent,
): AgentSessionRuntimeStatus {
  if (activity.status === 'running' || activity.status === 'waiting') {
    return activity.status;
  }
  if (activity.continuable && (existing.status === 'running' || existing.status === 'waiting')) {
    return existing.status;
  }
  return activity.status;
}

export function correlateSubagentToolSessions(
  nodes: readonly AiConversationNode[],
  activityNodes: readonly AgentActivityNode[] = [],
  viewSubagents: readonly AgentActivityAgent[] = [],
  sessions: readonly AiSessionSummary[] = [],
): {
  readonly toolChildSessionIds: ReadonlyMap<string, string>;
  readonly goalByChildId: ReadonlyMap<string, string>;
} {
  const subagentTools = flattenToolNodes(nodes)
    .filter((node) => isSubagentTool(node.name, node.nativeName))
    .sort((left, right) => left.firstSeq - right.firstSeq || left.key.localeCompare(right.key));
  if (subagentTools.length === 0) return EMPTY_CORRELATION;

  const toolChildSessionIds = new Map<string, string>();
  const goalByChildId = new Map<string, string>();

  const assignedChildIds = new Set<string>();
  const unresolvedSpawns: AiToolNode[] = [];

  for (const tool of subagentTools) {
    const action = subagentToolAction(tool.name, tool.nativeName);
    const explicitId = explicitChildSessionId(tool);
    if (explicitId) {
      toolChildSessionIds.set(tool.key, explicitId);
      if (action === 'spawn') {
        assignedChildIds.add(explicitId);
        const goal = firstNonEmptyString(asRecord(tool.input), ['goal']);
        if (goal) goalByChildId.set(explicitId, goal);
      }
    } else if (action === 'spawn') {
      unresolvedSpawns.push(tool);
    }
  }

  if (unresolvedSpawns.length > 0) {
    const descriptorActivities = activityNodes
      .filter((node) => node.kind === 'subagent')
      .map((node) => {
        const data = asRecord(node.data);
        const firstRecordData = node.records.length > 0 ? asRecord(node.records[0]?.data) : null;
        const childSessionId = firstNonEmptyString(data, ['childSessionId'])
          ?? firstNonEmptyString(firstRecordData, ['childSessionId']);
        const role = firstNonEmptyString(data, ['role'])
          ?? firstNonEmptyString(firstRecordData, ['role']);
        const rawContinuable = data?.continuable ?? firstRecordData?.continuable;
        const continuable = typeof rawContinuable === 'boolean' ? rawContinuable : undefined;
        return { firstSeq: node.firstSeq, childSessionId, role, continuable };
      })
      .filter((candidate): candidate is {
        firstSeq: number;
        childSessionId: string;
        role: string | undefined;
        continuable: boolean | undefined;
      } => Boolean(candidate.childSessionId))
      .sort((left, right) => left.firstSeq - right.firstSeq);

    const remainingSpawns: AiToolNode[] = [];
    for (const tool of unresolvedSpawns) {
      const { role, continuable } = spawnRoleAndContinuable(tool);
      const match = descriptorActivities.find((candidate) => (
        !assignedChildIds.has(candidate.childSessionId)
        && candidate.firstSeq >= tool.firstSeq
        && (!role || !candidate.role || candidate.role === role)
        && (candidate.continuable === undefined || candidate.continuable === continuable)
      )) ?? descriptorActivities.find((candidate) => (
        !assignedChildIds.has(candidate.childSessionId)
        && candidate.firstSeq >= tool.firstSeq
      ));
      if (match) {
        assignedChildIds.add(match.childSessionId);
        toolChildSessionIds.set(tool.key, match.childSessionId);
        const goal = firstNonEmptyString(asRecord(tool.input), ['goal']);
        if (goal) goalByChildId.set(match.childSessionId, goal);
      } else {
        remainingSpawns.push(tool);
      }
    }

    if (remainingSpawns.length > 0 && viewSubagents.length > 0) {
      const sessionById = new Map(sessions.map((summary) => [summary.id, summary]));
      for (const tool of remainingSpawns) {
        const { role, continuable } = spawnRoleAndContinuable(tool);
        const goal = firstNonEmptyString(asRecord(tool.input), ['goal']);
        const goalTitle = goal ? fallbackSessionTitle(goal) : undefined;
        const candidates = viewSubagents.filter((agent) => (
          !assignedChildIds.has(agent.sessionId)
          && (!role || agent.role === role)
          && agent.continuable === continuable
        ));
        const exactTitleMatch = goalTitle
          ? candidates.find((agent) => sessionById.get(agent.sessionId)?.title === goalTitle)
          : undefined;
        const match = exactTitleMatch ?? candidates[0];
        if (match) {
          assignedChildIds.add(match.sessionId);
          toolChildSessionIds.set(tool.key, match.sessionId);
          if (goal) goalByChildId.set(match.sessionId, goal);
        }
      }
    }
  }

  return { toolChildSessionIds, goalByChildId };
}

export function buildSubagentLineage(
  view: Pick<AiSessionView, 'summary' | 'status' | 'subagents'> | null,
  sessions: readonly AiSessionSummary[],
  goalByChildId?: ReadonlyMap<string, string>,
): AiSubagentLineage | null {
  if (!view) return null;
  const byId = new Map(sessions.map((summary) => [summary.id, summary]));
  byId.set(view.summary.id, { ...view.summary, status: view.status });
  const projected = new Map(
    (view.subagents ?? []).map((subagent) => [subagent.sessionId, subagent]),
  );
  for (const activity of projected.values()) {
    const existing = byId.get(activity.sessionId);
    const goal = goalByChildId?.get(activity.sessionId);
    const fallbackTitle = goal ? fallbackSessionTitle(goal) : activity.sessionId;
    byId.set(activity.sessionId, existing
      ? {
          ...existing,
          status: mergeSubagentStatus(existing, activity),
          parentSessionId: activity.parentSessionId ?? existing.parentSessionId,
          subagent: {
            descriptorId: activity.descriptorId ?? existing.subagent?.descriptorId ?? activity.sessionId,
            role: activity.role,
            continuable: activity.continuable,
            depth: activity.depth,
          },
        }
      : {
          id: activity.sessionId,
          kind: 'agent',
          title: fallbackTitle,
          updatedAt: view.summary.updatedAt,
          status: activity.status,
          scopeKey: view.summary.scopeKey,
          targetId: view.summary.targetId,
          parentSessionId: activity.parentSessionId ?? view.summary.id,
          subagent: {
            descriptorId: activity.descriptorId ?? activity.sessionId,
            role: activity.role,
            continuable: activity.continuable,
            depth: activity.depth,
          },
          archived: false,
        });
  }

  const current = byId.get(view.summary.id) ?? view.summary;
  const reverseTrail: AiSessionSummary[] = [current];
  let root = current;
  const ancestorIds = new Set([current.id]);
  while (root.subagent && root.parentSessionId) {
    const parentCandidate = byId.get(root.parentSessionId);
    if (!parentCandidate || ancestorIds.has(parentCandidate.id)) break;
    ancestorIds.add(parentCandidate.id);
    reverseTrail.push(parentCandidate);
    root = parentCandidate;
  }
  const trail = reverseTrail.reverse();
  const parent = trail.length > 1 ? trail[trail.length - 2]! : null;

  const children = new Map<string, AiSessionSummary[]>();
  for (const summary of byId.values()) {
    if (!summary.subagent || !summary.parentSessionId) continue;
    const siblings = children.get(summary.parentSessionId);
    if (siblings) siblings.push(summary);
    else children.set(summary.parentSessionId, [summary]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    ));
  }

  const collectSubtree = (anchorId: string): AiSubagentEntry[] => {
    const collected: AiSubagentEntry[] = [];
    const visited = new Set<string>([anchorId]);
    const appendChildren = (parentSessionId: string, depth: number): void => {
      for (const summary of children.get(parentSessionId) ?? []) {
        if (visited.has(summary.id)) continue;
        visited.add(summary.id);
        const activity = projected.get(summary.id);
        collected.push({
          summary,
          parentSessionId: summary.parentSessionId,
          role: activity?.role ?? summary.subagent!.role,
          continuable: activity?.continuable ?? summary.subagent!.continuable,
          status: summary.status,
          depth,
          detail: activity?.summary,
        });
        appendChildren(summary.id, depth + 1);
      }
    };
    appendChildren(anchorId, 1);
    return collected;
  };

  const entries = collectSubtree(root.id);
  const currentChildren = current.id === root.id ? entries : collectSubtree(current.id);
  const entryById = new Map(entries.map((entry) => [entry.summary.id, entry]));

  return {
    root,
    current,
    parent,
    trail,
    entries,
    currentChildren,
    byId,
    entryById,
  };
}

const VALID_PLAN_STATUSES = new Set<AgentSessionPlanStep['status']>([
  'pending',
  'inProgress',
  'completed',
  'blocked',
  'failed',
]);

function extractPlanSteps(value: unknown): readonly SubagentToolPlanStep[] {
  if (!Array.isArray(value)) return [];
  const steps: SubagentToolPlanStep[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = firstNonEmptyString(record, ['id']);
    const title = firstNonEmptyString(record, ['title']);
    const status = firstNonEmptyString(record, ['status']) as AgentSessionPlanStep['status'] | undefined;
    if (id && title && status && VALID_PLAN_STATUSES.has(status)) {
      steps.push({ id, title, status });
    }
  }
  return steps;
}

function extractOutputStatus(output: UnknownRecord | null): AgentSessionRuntimeStatus | null {
  const direct = firstNonEmptyString(output, ['status']);
  const snapshotStatus = firstNonEmptyString(asRecord(output?.snapshot), ['status']);
  const raw = (direct ?? snapshotStatus)?.toLowerCase();
  switch (raw) {
    case 'idle':
    case 'running':
    case 'waiting':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw;
    default:
      return null;
  }
}

export function extractSubagentToolSummary(
  node: AiToolNode,
  lineage: AiSubagentLineage | null,
  toolChildSessionIds: ReadonlyMap<string, string>,
): SubagentToolSummary {
  const action = subagentToolAction(node.name, node.nativeName) ?? 'spawn';
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const childSessionId = toolChildSessionIds.get(node.key) ?? explicitChildSessionId(node);
  const linkedEntry = childSessionId ? lineage?.entryById.get(childSessionId) : undefined;
  const linkedSummary = childSessionId ? lineage?.byId.get(childSessionId) : undefined;

  const canonical = resolveCanonicalSubagentName(node.name, node.nativeName);
  const snapshot = asRecord(output?.snapshot);
  const snapshotHeader = asRecord(snapshot?.header);
  const snapshotRole = firstNonEmptyString(asRecord(snapshotHeader?.subagent), ['role']);
  const role = linkedEntry?.role ?? firstNonEmptyString(input, ['role']) ?? snapshotRole ?? 'subagent';
  const continuable = linkedEntry?.continuable
    ?? (typeof output?.continuable === 'boolean'
      ? output.continuable
      : canonical === 'spawn_continuable_agent'
        ? true
        : canonical === 'spawn_one_shot_agent'
          ? false
          : undefined);

  const goal = firstNonEmptyString(input, ['goal']);
  const inputContent = firstNonEmptyString(input, ['content']);
  const goalFirstLine = goal?.split('\n')[0]?.trim();
  const inputFirstLine = inputContent?.split('\n')[0]?.trim();
  const snapshotGoalFirstLine = firstNonEmptyString(snapshotHeader, ['goal'])?.split('\n')[0]?.trim();
  const snapshotTitle = firstNonEmptyString(snapshotHeader, ['title'])
    ?? (snapshotGoalFirstLine && snapshotGoalFirstLine.length > 0
      ? fallbackSessionTitle(snapshotGoalFirstLine)
      : undefined);

  const title = action === 'spawn'
    ? (goalFirstLine && goalFirstLine.length > 0 ? fallbackSessionTitle(goalFirstLine) : undefined)
      ?? linkedSummary?.title
      ?? childSessionId
      ?? node.name
    : linkedSummary?.title
      ?? snapshotTitle
      ?? (inputFirstLine && inputFirstLine.length > 0 ? fallbackSessionTitle(inputFirstLine) : undefined)
      ?? childSessionId
      ?? (node.summary && node.summary !== 'Agent orchestration' ? node.summary : undefined)
      ?? node.name;

  const outputStatus = extractOutputStatus(output);
  const partial = output?.partial === true;

  let status: AgentSessionRuntimeStatus | 'approval' | 'uncertain';
  if (node.state === 'approval') {
    status = 'approval';
  } else if (node.state === 'preparing' || node.state === 'running') {
    status = action !== 'inspect' && linkedEntry?.status === 'waiting' ? 'waiting' : 'running';
  } else if (node.state === 'failed' || node.state === 'rejected') {
    status = outputStatus === 'cancelled' ? 'cancelled' : 'failed';
  } else if (node.state === 'uncertain') {
    status = 'uncertain';
  } else {
    if (action === 'inspect') status = 'completed';
    else if (outputStatus === 'failed') status = 'failed';
    else if (outputStatus === 'cancelled') status = 'cancelled';
    else if (outputStatus === 'running' || outputStatus === 'waiting') status = outputStatus;
    else if (outputStatus === 'idle' || outputStatus === 'completed') status = 'completed';
    else if (action === 'cancel') status = 'cancelled';
    else if (linkedEntry && (linkedEntry.status === 'failed' || linkedEntry.status === 'cancelled')) {
      status = linkedEntry.status;
    } else {
      status = 'completed';
    }
  }

  const rawSummary = node.summary && node.summary !== 'Agent orchestration' ? node.summary : undefined;
  const outputSummary = firstNonEmptyString(output, ['summary', 'stopReason']);
  const resultSummary = rawSummary ?? outputSummary ?? (linkedEntry?.detail && linkedEntry.detail !== title ? linkedEntry.detail : undefined);
  const errorMessage = node.state === 'failed' || node.state === 'rejected' || node.state === 'uncertain'
    ? node.error ?? rawSummary ?? firstNonEmptyString(output, ['error'])
    : undefined;

  const usage = asRecord(output?.usage);
  const toolCallCount = firstFiniteNumber(usage, ['toolCalls', 'tool_calls']);
  const elapsedMs = firstFiniteNumber(usage, ['elapsedMs', 'elapsed_ms']);
  const durationMs = node.durationMs ?? elapsedMs;

  return {
    action,
    childSessionId,
    role,
    continuable,
    title,
    goal,
    inputContent,
    status,
    partial,
    resultSummary,
    errorMessage,
    plan: extractPlanSteps(output?.plan),
    toolCallCount,
    durationMs,
  };
}

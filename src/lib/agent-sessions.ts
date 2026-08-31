import { enqueueAiSessionPersistence } from '@/lib/ai-session-persistence-queue';
import { createLogger } from '@/lib/logger';
import { redactSensitiveValue } from '@/lib/terminal-output-buffer';
import {
  invokeAppendAiSessionAgentState,
  invokeClearAiSessionLane,
} from '@/lib/tauri';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { auditRecoveredAgentTool } from '@/lib/agent-recovery-audit';
import type { AiSessionFile } from '@/types/ai';
import type {
  AgentChatMessage,
  AgentRunRecord,
  PersistedAgentMessagePatch,
  PersistedAgentMessageSet,
  PersistedAgentRunSet,
  PersistedAgentRunState,
  PersistedAgentStateEnvelope,
} from '@/types/agent';

const logger = createLogger('agentSessions');
const PERSIST_DEBOUNCE_MS = 100;
const MAX_CONTENT_DELTA_BYTES = 128 * 1024;
const MAX_PATCH_BATCH_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const STREAMING_SECRET_BOUNDARIES = [
  '://',
  'authorization:',
  'api_key=',
  'api-key=',
  'apikey=',
  'access_token=',
  'access-token=',
  'access_key=',
  'access-key=',
  'auth_token=',
  'auth-token=',
  'client_secret=',
  'client-secret=',
  'private_key=',
  'private-key=',
  'password=',
  'password:',
  'passwd=',
  'passwd:',
  'passphrase=',
  'passphrase:',
  'pwd=',
  'pwd:',
  'secret=',
  'secret:',
  'token=',
  'token:',
  '--api-key',
  '--api_key',
  '--access-token',
  '--access_token',
  '--auth-token',
  '--auth_token',
  '--client-secret',
  '--client_secret',
  '--password',
  '--passwd',
  '--passphrase',
  '--private-key',
  '--secret',
  '--token',
  'akia',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'sk-',
  'aiza',
  'glpat-',
  'npm_',
  'xoxb-',
  'xoxa-',
  'xoxp-',
  'xoxr-',
  'xoxs-',
  'sk_live_',
  'sk_test_',
  'eyj',
  '-----begin',
] as const;
const BACKEND_SUSPICIOUS_TEXT_MARKERS = [
  'authorization:',
  'api_key=',
  'api-key=',
  'apikey=',
  'access_token=',
  'access-token=',
  'auth_token=',
  'auth-token=',
  'client_secret=',
  'client-secret=',
  'aws_secret_access_key=',
  'aws-secret-access-key=',
  'openai_api_key=',
  'openai-api-key=',
  'anthropic_api_key=',
  'anthropic-api-key=',
  'google_api_key=',
  'google-api-key=',
  'password=',
  'password:',
  'passwd=',
  'passwd:',
  'passphrase=',
  'passphrase:',
  'private_key=',
  'private-key=',
  'secret=',
  'secret:',
  'token=',
  'token:',
  '--api-key',
  '--api_key',
  '--access-token',
  '--access_token',
  '--auth-token',
  '--auth_token',
  '--client-secret',
  '--client_secret',
  '--password',
  '--passwd',
  '--passphrase',
  '--private-key',
  '--secret',
  '--token',
] as const;
const BACKEND_TOKEN_TRIM_CHARACTERS = new Set(['"', "'", ',', ';', ')', ']', '}']);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<Promise<void>>();
const persistedSnapshots = new Map<string, PersistedAgentRunState>();
const initialCheckpoints = new Map<string, PersistedAgentRunState>();
let unsubscribe: (() => void) | undefined;
let hydrating = false;

type AgentPatchEnvelope = Extract<PersistedAgentStateEnvelope, { kind: 'patch' }>;
type AgentPatchBody = Omit<AgentPatchEnvelope, 'kind' | 'version' | 'requestId'>;

function trimBackendToken(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && BACKEND_TOKEN_TRIM_CHARACTERS.has(value[start])) start += 1;
  while (end > start && BACKEND_TOKEN_TRIM_CHARACTERS.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function containsBackendWellKnownToken(value: string): boolean {
  const separatedTokens = value.split(/[^A-Za-z0-9_]+/);
  if (separatedTokens.some((token) => (
    (token.startsWith('AKIA')
      && token.length === 20
      && /^[A-Z0-9]+$/.test(token))
    || ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].some((prefix) => (
      token.startsWith(prefix) && token.length >= prefix.length + 20
    ))
  ))) return true;

  return value.split(/\s+/).some((part) => {
    const token = trimBackendToken(part);
    const prefix = [
      'sk-',
      'sk-ant-',
      'AIza',
      'glpat-',
      'npm_',
      'xoxb-',
      'xoxa-',
      'xoxp-',
      'xoxr-',
      'xoxs-',
      'sk_live_',
      'sk_test_',
    ].find((candidate) => token.startsWith(candidate));
    return Boolean(
      prefix
      && token.length >= prefix.length + 20
      && /^[A-Za-z0-9_-]+$/.test(token),
    );
  });
}

function containsBackendJwt(value: string): boolean {
  return value.split(/\s+/).some((part) => {
    const segments = trimBackendToken(part).split('.');
    return segments.length === 3
      && segments[0].startsWith('eyJ')
      && segments[1].length >= 8
      && segments[2].length >= 8;
  });
}

function containsBackendUrlCredentials(value: string): boolean {
  return value.split(/\s+/).some((part) => {
    const schemeIndex = part.indexOf('://');
    if (schemeIndex < 0) return false;
    const authority = part.slice(schemeIndex + 3).split('/')[0];
    const atIndex = authority.indexOf('@');
    return atIndex >= 0 && authority.slice(0, atIndex).includes(':');
  });
}

function canonicalBackendRedactedText(value: string): string {
  const lower = value.toLowerCase();
  if (
    lower.includes('-----begin openssh private key-----')
    || lower.includes('-----begin rsa private key-----')
    || lower.includes('-----begin ec private key-----')
    || lower.includes('-----begin dsa private key-----')
    || lower.includes('-----begin encrypted private key-----')
    || lower.includes('-----begin private key-----')
  ) return '[REDACTED PRIVATE KEY]';
  if (
    BACKEND_SUSPICIOUS_TEXT_MARKERS.some((marker) => lower.includes(marker))
    || containsBackendWellKnownToken(value)
    || containsBackendJwt(value)
    || containsBackendUrlCredentials(value)
  ) return '[REDACTED]';
  return value;
}

function canonicalizeBackendRedaction<T>(value: T): T {
  if (typeof value === 'string') return canonicalBackendRedactedText(value) as T;
  if (Array.isArray(value)) return value.map(canonicalizeBackendRedaction) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => (
    [key, canonicalizeBackendRedaction(item)]
  ))) as T;
}

const RUN_SET_FIELDS = [
  'conversationStartedAt',
  'goal',
  'providerId',
  'target',
  'targetTitle',
  'permissionMode',
  'rolloutStage',
  'phase',
  'status',
  'stopRequested',
  'fallback',
  'error',
  'maxToolSteps',
  'toolResultTimeoutMs',
  'stepLimitReached',
] as const satisfies readonly (keyof PersistedAgentRunSet)[];

const MESSAGE_SET_FIELDS = [
  'conversationId',
  'role',
  'status',
  'providerId',
  'target',
] as const satisfies readonly (keyof PersistedAgentMessageSet)[];

function stableStreamingContent(value: string): string {
  const lower = value.toLowerCase();
  let boundary = value.length;
  for (const marker of STREAMING_SECRET_BOUNDARIES) {
    const candidate = lower.indexOf(marker);
    if (candidate >= 0) boundary = Math.min(boundary, candidate);
  }
  // A credential can become recognizable only after a later stream chunk
  // supplies its suffix (for example the `@host` in URL userinfo). Persist the
  // stable prefix before the first possible secret start and flush the withheld
  // suffix once the message reaches a terminal status and can be redacted as a
  // whole. This prevents partial credentials from becoming immutable JSONL.
  return boundary === value.length ? value : value.slice(0, boundary);
}

function snapshotForRun(requestId: string): PersistedAgentRunState | undefined {
  const state = useAgentStore.getState();
  const run = state.runs[requestId];
  if (!run) return undefined;
  const messages = state.messages
    .filter((message) => message.requestId === requestId)
    .map((message) => (
      message.status === 'streaming'
        ? { ...message, content: stableStreamingContent(message.content) }
        : message
    ));
  const tools = run.toolCallIds.flatMap((callId) => {
    const snapshot = state.tools[agentToolKey(requestId, callId)];
    if (!snapshot) return [];
    const { approval: _approval, ...persistable } = snapshot;
    return [persistable];
  });
  // Rust applies the same coarse, defense-in-depth redaction before writing.
  // Canonicalize that second pass here so UTF-8 offsets are based on the exact
  // bytes that the backend persists, even for labels such as password=...
  return canonicalizeBackendRedaction(redactSensitiveValue({ run, messages, tools }));
}

function track(operation: Promise<void>): Promise<void> {
  inFlight.add(operation);
  const cleanup = (): void => {
    inFlight.delete(operation);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendedIds(
  previous: readonly string[],
  current: readonly string[],
): readonly string[] | undefined {
  if (current.length < previous.length) return undefined;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== current[index]) return undefined;
  }
  return current.slice(previous.length);
}

function changedFields<T extends object, K extends keyof T>(
  previous: T,
  current: T,
  fields: readonly K[],
): Partial<Pick<T, K>> {
  return Object.fromEntries(fields.flatMap((field) => (
    isEqual(previous[field], current[field]) ? [] : [[field, current[field]]]
  ))) as Partial<Pick<T, K>>;
}

function removesDefinedField<T extends object, K extends keyof T>(
  previous: T,
  current: T,
  fields: readonly K[],
): boolean {
  return fields.some((field) => previous[field] !== undefined && current[field] === undefined);
}

function createPatch(requestId: string, body: AgentPatchBody): AgentPatchEnvelope {
  return { kind: 'patch', version: 1, requestId, ...body };
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  let byteLength = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (byteLength > 0 && byteLength + codePointBytes > maxBytes) {
      chunks.push(value.slice(start, index));
      start = index;
      byteLength = 0;
    }
    byteLength += codePointBytes;
    index += codeUnits;
  }
  chunks.push(value.slice(start));
  return chunks;
}

function messagePatchEnvelopes(
  requestId: string,
  previous: AgentChatMessage | undefined,
  current: AgentChatMessage,
): AgentPatchEnvelope[] {
  if (!previous) {
    return [createPatch(requestId, { messages: [{ id: current.id, upsert: current }] })];
  }
  const addedToolCallIds = appendedIds(previous.toolCallIds, current.toolCallIds);
  const mustReplace = previous.requestId !== current.requestId
    || addedToolCallIds === undefined
    || !current.content.startsWith(previous.content)
    || removesDefinedField(previous, current, MESSAGE_SET_FIELDS);
  if (mustReplace) {
    return [createPatch(requestId, { messages: [{ id: current.id, upsert: current }] })];
  }

  const set = changedFields(previous, current, MESSAGE_SET_FIELDS);
  const suffix = current.content.slice(previous.content.length);
  const contentChunks = splitUtf8(suffix, MAX_CONTENT_DELTA_BYTES);
  const hasSet = Object.keys(set).length > 0;
  const hasToolCallIds = addedToolCallIds.length > 0;
  if (contentChunks.length === 0 && !hasSet && !hasToolCallIds) return [];

  let nextContentOffsetBytes = encoder.encode(previous.content).byteLength;
  const patches: PersistedAgentMessagePatch[] = contentChunks.length > 0
    ? contentChunks.map((appendContent, index) => {
        const contentOffsetBytes = nextContentOffsetBytes;
        nextContentOffsetBytes += encoder.encode(appendContent).byteLength;
        return {
          id: current.id,
          appendContent,
          contentOffsetBytes,
          ...(index === 0 && hasSet ? { set } : {}),
          ...(index === 0 && hasToolCallIds ? { appendToolCallIds: addedToolCallIds } : {}),
        };
      })
    : [{
        id: current.id,
        ...(hasSet ? { set } : {}),
        ...(hasToolCallIds ? { appendToolCallIds: addedToolCallIds } : {}),
      }];
  return patches.map((message) => createPatch(requestId, { messages: [message] }));
}

function buildAtomicPatches(
  previous: PersistedAgentRunState,
  current: PersistedAgentRunState,
): AgentPatchEnvelope[] | undefined {
  const requestId = current.run.requestId;
  if (
    previous.run.requestId !== requestId
    || previous.run.conversationId !== current.run.conversationId
    || removesDefinedField(previous.run, current.run, RUN_SET_FIELDS)
  ) return undefined;

  const addedRunToolCallIds = appendedIds(previous.run.toolCallIds, current.run.toolCallIds);
  if (!addedRunToolCallIds) return undefined;

  const previousTools = new Map(previous.tools.map((tool) => [tool.toolCall.callId, tool]));
  const currentToolIds = new Set(current.tools.map((tool) => tool.toolCall.callId));
  if (previous.tools.some((tool) => !currentToolIds.has(tool.toolCall.callId))) return undefined;

  const patches: AgentPatchEnvelope[] = [];
  const runSet = changedFields(previous.run, current.run, RUN_SET_FIELDS);
  if (Object.keys(runSet).length > 0 || addedRunToolCallIds.length > 0) {
    patches.push(createPatch(requestId, {
      run: {
        ...(Object.keys(runSet).length > 0 ? { set: runSet } : {}),
        ...(addedRunToolCallIds.length > 0
          ? { appendToolCallIds: addedRunToolCallIds }
          : {}),
      },
    }));
  }

  const previousMessages = new Map(previous.messages.map((message) => [message.id, message]));
  const currentMessageIds = new Set(current.messages.map((message) => message.id));
  const removedMessageIds = previous.messages
    .filter((message) => !currentMessageIds.has(message.id))
    .map((message) => message.id);
  if (removedMessageIds.length > 0) {
    patches.push(createPatch(requestId, { removedMessageIds }));
  }
  for (const message of current.messages) {
    patches.push(...messagePatchEnvelopes(
      requestId,
      previousMessages.get(message.id),
      message,
    ));
  }

  for (const tool of current.tools) {
    if (!isEqual(previousTools.get(tool.toolCall.callId), tool)) {
      patches.push(createPatch(requestId, { tools: [tool] }));
    }
  }
  return patches;
}

function mergePatches(
  left: AgentPatchEnvelope,
  right: AgentPatchEnvelope,
): AgentPatchEnvelope {
  return createPatch(left.requestId, {
    ...(left.run || right.run ? {
      run: {
        set: { ...left.run?.set, ...right.run?.set },
        appendToolCallIds: [
          ...(left.run?.appendToolCallIds ?? []),
          ...(right.run?.appendToolCallIds ?? []),
        ],
      },
    } : {}),
    ...(left.messages || right.messages
      ? { messages: [...(left.messages ?? []), ...(right.messages ?? [])] }
      : {}),
    ...(left.removedMessageIds || right.removedMessageIds ? {
      removedMessageIds: [
        ...(left.removedMessageIds ?? []),
        ...(right.removedMessageIds ?? []),
      ],
    } : {}),
    ...(left.tools || right.tools
      ? { tools: [...(left.tools ?? []), ...(right.tools ?? [])] }
      : {}),
  });
}

function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function batchPatches(patches: readonly AgentPatchEnvelope[]): AgentPatchEnvelope[] {
  const batches: AgentPatchEnvelope[] = [];
  for (const patch of patches) {
    const previous = batches[batches.length - 1];
    if (!previous) {
      batches.push(patch);
      continue;
    }
    const merged = mergePatches(previous, patch);
    if (encodedBytes(merged) <= MAX_PATCH_BATCH_BYTES) {
      batches[batches.length - 1] = merged;
    } else {
      batches.push(patch);
    }
  }
  return batches;
}

function appendUnique(previous: readonly string[], added: readonly string[]): string[] {
  const result = [...previous];
  const seen = new Set(previous);
  for (const value of added) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function appendContentAtOffset(
  current: string,
  appended: string,
  offset: number | undefined,
): string {
  if (offset === undefined) return current + appended;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Agent message content offset must be a non-negative safe integer');
  }
  const currentBytes = encoder.encode(current);
  if (offset > currentBytes.byteLength) {
    throw new Error('Agent message content patch has a gap before its offset');
  }
  if (offset < currentBytes.byteLength && (currentBytes[offset] & 0xc0) === 0x80) {
    throw new Error('Agent message content offset splits a UTF-8 character');
  }
  const appendedBytes = encoder.encode(appended);
  const available = currentBytes.byteLength - offset;
  const overlap = Math.min(available, appendedBytes.byteLength);
  for (let index = 0; index < overlap; index += 1) {
    if (currentBytes[offset + index] !== appendedBytes[index]) {
      throw new Error('Agent message content patch conflicts with persisted content');
    }
  }
  if (available >= appendedBytes.byteLength) return current;
  if (overlap > 0 && (appendedBytes[overlap] & 0xc0) === 0x80) {
    throw new Error('Agent message content overlap splits a UTF-8 character');
  }

  const missing = appendedBytes.slice(overlap);
  const combined = new Uint8Array(currentBytes.byteLength + missing.byteLength);
  combined.set(currentBytes);
  combined.set(missing, currentBytes.byteLength);
  return decoder.decode(combined);
}

function applyPatch(
  previous: PersistedAgentRunState,
  patch: AgentPatchEnvelope,
): PersistedAgentRunState {
  const run: AgentRunRecord = {
    ...previous.run,
    ...patch.run?.set,
    toolCallIds: appendUnique(
      previous.run.toolCallIds,
      patch.run?.appendToolCallIds ?? [],
    ),
  };
  let messages = previous.messages.filter((message) => (
    !patch.removedMessageIds?.includes(message.id)
  ));
  for (const item of patch.messages ?? []) {
    const index = messages.findIndex((message) => message.id === item.id);
    if (item.contentOffsetBytes !== undefined && item.appendContent === undefined) {
      throw new Error('Agent message content offset requires appended content');
    }
    if (item.upsert) {
      messages = index >= 0
        ? messages.map((message, messageIndex) => (
            messageIndex === index ? item.upsert as AgentChatMessage : message
          ))
        : [...messages, item.upsert];
      continue;
    }
    if (index < 0) throw new Error(`Agent message patch has no base: ${item.id}`);
    const existing = messages[index];
    messages = messages.map((message, messageIndex) => (
      messageIndex === index
        ? {
            ...existing,
            ...item.set,
            content: item.appendContent === undefined
              ? existing.content
              : appendContentAtOffset(
                  existing.content,
                  item.appendContent,
                  item.contentOffsetBytes,
                ),
            toolCallIds: appendUnique(
              existing.toolCallIds,
              item.appendToolCallIds ?? [],
            ),
          }
        : message
    ));
  }

  let tools = [...previous.tools];
  for (const tool of patch.tools ?? []) {
    const index = tools.findIndex((item) => item.toolCall.callId === tool.toolCall.callId);
    if (index >= 0) {
      tools[index] = tool;
    } else {
      tools.push(tool);
    }
  }
  return { run, messages, tools };
}

interface PersistenceStep {
  readonly envelope: PersistedAgentStateEnvelope;
  readonly resultingState: PersistedAgentRunState;
}

function persistenceSteps(
  previous: PersistedAgentRunState | undefined,
  current: PersistedAgentRunState,
): PersistenceStep[] {
  if (!previous) {
    return [{
      envelope: { kind: 'checkpoint', version: 1, state: current },
      resultingState: current,
    }];
  }
  const atomic = buildAtomicPatches(previous, current);
  if (!atomic) {
    return [{
      envelope: { kind: 'checkpoint', version: 1, state: current },
      resultingState: current,
    }];
  }
  let working = previous;
  return batchPatches(atomic).map((envelope) => {
    working = applyPatch(working, envelope);
    return { envelope, resultingState: working };
  });
}

export function persistAgentRunState(requestId: string): Promise<void> {
  const run = useAgentStore.getState().runs[requestId];
  if (!run) return Promise.resolve();
  const { conversationId, conversationStartedAt } = run;
  const operation = enqueueAiSessionPersistence(conversationId, async () => {
    const snapshot = snapshotForRun(requestId);
    if (!snapshot || snapshot.run.conversationId !== conversationId) return;
    const initial = persistedSnapshots.has(requestId)
      ? undefined
      : initialCheckpoints.get(requestId);
    const targets = initial ? [initial, snapshot] : [snapshot];
    for (const [targetIndex, target] of targets.entries()) {
      const steps = persistenceSteps(persistedSnapshots.get(requestId), target);
      for (const step of steps) {
        await invokeAppendAiSessionAgentState(
          conversationId,
          conversationStartedAt,
          step.envelope,
        );
        // Advance only after each durable append. If a later chunk fails, a retry
        // resumes from this exact prefix and cannot duplicate content.
        persistedSnapshots.set(requestId, step.resultingState);
      }
      if (initial && targetIndex === 0) initialCheckpoints.delete(requestId);
    }
  });
  return track(operation);
}

export function stageAgentRunPersistence(requestId: string): void {
  const existing = timers.get(requestId);
  if (existing) clearTimeout(existing);
  timers.set(requestId, setTimeout(() => {
    timers.delete(requestId);
    void persistAgentRunState(requestId).catch((error) => {
      logger.warn('Failed to persist Agent run state', error);
    });
  }, PERSIST_DEBOUNCE_MS));
}

export function initializeAgentSessionPersistence(): () => void {
  if (unsubscribe) return unsubscribe;
  const stop = useAgentStore.subscribe((state, previous) => {
    if (hydrating || (
      state.runs === previous.runs
      && state.messages === previous.messages
      && state.tools === previous.tools
    )) return;
    const changed = new Set<string>();
    const newRequests = new Set<string>();
    for (const [requestId, run] of Object.entries(state.runs)) {
      if (previous.runs[requestId] === run) continue;
      changed.add(requestId);
      if (!previous.runs[requestId]) newRequests.add(requestId);
    }
    for (const requestId of Object.keys(previous.runs)) {
      if (state.runs[requestId]) continue;
      const timer = timers.get(requestId);
      if (timer) clearTimeout(timer);
      timers.delete(requestId);
      persistedSnapshots.delete(requestId);
      initialCheckpoints.delete(requestId);
    }
    const previousMessages = new Map(previous.messages.map((message) => [message.id, message]));
    for (const message of state.messages) {
      if (previousMessages.get(message.id) !== message) changed.add(message.requestId);
    }
    for (const [key, tool] of Object.entries(state.tools)) {
      if (previous.tools[key] !== tool) changed.add(tool.toolCall.requestId);
    }
    for (const requestId of newRequests) {
      persistedSnapshots.delete(requestId);
      const initial = snapshotForRun(requestId);
      if (initial) initialCheckpoints.set(requestId, initial);
      changed.delete(requestId);
      // Establish the small initial checkpoint before provider streaming can
      // grow the first record beyond the backend's per-record limit.
      void persistAgentRunState(requestId).catch((error) => {
        logger.warn('Failed to persist initial Agent run state', error);
      });
    }
    for (const requestId of changed) stageAgentRunPersistence(requestId);
  });
  unsubscribe = () => {
    stop();
    unsubscribe = undefined;
  };
  return unsubscribe;
}

export function hydrateAgentSession(session: AiSessionFile): void {
  const state = useAgentStore.getState();
  const active = state.activeRequestId ? state.runs[state.activeRequestId] : undefined;
  if (active?.conversationId === session.conversation.id) return;
  for (const run of Object.values(state.runs)) {
    if (run.conversationId !== session.conversation.id) continue;
    const timer = timers.get(run.requestId);
    if (timer) clearTimeout(timer);
    timers.delete(run.requestId);
    persistedSnapshots.delete(run.requestId);
    initialCheckpoints.delete(run.requestId);
  }
  hydrating = true;
  try {
    useAgentStore.getState().hydrateConversation(
      session.conversation.id,
      session.agentStates ?? [],
    );
    const recoveredState = useAgentStore.getState();
    for (const item of session.agentStates ?? []) {
      const recovered = recoveredState.runs[item.run.requestId];
      if (recovered?.conversationId !== session.conversation.id) continue;
      const recoveredSnapshot = snapshotForRun(recovered.requestId);
      if (recoveredSnapshot) persistedSnapshots.set(recovered.requestId, recoveredSnapshot);
      for (const callId of recovered.toolCallIds) {
        const tool = recoveredState.tools[agentToolKey(recovered.requestId, callId)];
        if (tool?.recoveredFromStatus) auditRecoveredAgentTool(tool);
      }
    }
  } finally {
    hydrating = false;
  }
}

export async function flushAgentSessionPersistence(): Promise<void> {
  const requestIds = [...timers.keys()];
  for (const requestId of requestIds) {
    const timer = timers.get(requestId);
    if (timer) clearTimeout(timer);
    timers.delete(requestId);
    await persistAgentRunState(requestId);
  }
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

export async function clearAgentConversationData(
  conversationId: string,
  startedAt: string,
): Promise<void> {
  const state = useAgentStore.getState();
  const active = state.activeRequestId
    ? state.runs[state.activeRequestId]
    : undefined;
  if (active?.conversationId === conversationId) {
    throw new Error('Active Agent task must be cancelled before clearing its lane.');
  }
  await flushAgentSessionPersistence();
  await enqueueAiSessionPersistence(conversationId, () => {
    const currentState = useAgentStore.getState();
    const currentActive = currentState.activeRequestId
      ? currentState.runs[currentState.activeRequestId]
      : undefined;
    if (currentActive?.conversationId === conversationId) {
      throw new Error('A new Agent task started before its lane could be cleared.');
    }
    return invokeClearAiSessionLane(conversationId, startedAt, 'agent');
  });
  for (const run of Object.values(useAgentStore.getState().runs)) {
    if (run.conversationId !== conversationId) continue;
    persistedSnapshots.delete(run.requestId);
    initialCheckpoints.delete(run.requestId);
  }
  useAgentStore.getState().clearConversation(conversationId);
}

export function agentRequestIdsForSession(sessionId: string): string[] {
  return Object.values(useAgentStore.getState().runs)
    .filter((run) => run.target.sessionId === sessionId && run.status === 'running')
    .map((run) => run.requestId);
}

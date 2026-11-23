import type {
  AiBackgroundJobLink,
  AiBackgroundJobObservationSummary,
  AiConversationNode,
  AiToolNode,
  AiTurnProcessChildNode,
} from './conversation-node';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstNumber(record: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizedToolName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/[.\-]/gu, '_');
}

function backgroundObservationAction(node: AiToolNode): 'wait' | 'kill' | null {
  const names = [normalizedToolName(node.name), normalizedToolName(node.nativeName)];
  if (names.some(name => name === 'kill_process' || name === 'process_kill' || name === 'stop_process')) return 'kill';
  if (names.some(name => name === 'wait_process' || name === 'process_wait' || name === 'wait_terminal')) return 'wait';
  return null;
}

function extractProcessHandle(node: AiToolNode): string | null {
  const output = asRecord(node.output);
  const job = asRecord(output?.job);
  const input = asRecord(node.input);
  return firstString(output, ['processHandle', 'process_handle'])
    ?? firstString(job, ['processHandle', 'process_handle'])
    ?? firstString(input, ['processHandle', 'process_handle']);
}

function extractObservationOutput(output: Record<string, unknown> | null): string {
  if (!output) return '';
  if (typeof output.combinedOutput === 'string') return output.combinedOutput;
  const stdout = typeof output.stdout === 'string' ? output.stdout : '';
  const stderr = typeof output.stderr === 'string' ? output.stderr : '';
  const separator = stdout && stderr && !stdout.endsWith('\n') && !stderr.startsWith('\n') ? '\n' : '';
  return `${stdout}${separator}${stderr}`;
}

function parseObservedJobState(
  node: AiToolNode,
  output: Record<string, unknown> | null,
  exitCode: number | null,
): AiBackgroundJobObservationSummary['state'] {
  if (node.state === 'running' || node.state === 'preparing') return 'running';
  const job = asRecord(output?.job);
  const rawState = (firstString(job, ['state']) ?? firstString(output, ['state']) ?? '').toLowerCase();
  if (rawState === 'exited' || rawState === 'completed') return 'exited';
  if (rawState === 'running' || rawState === 'starting') return 'running';
  if (rawState === 'rejected') return 'rejected';
  if (rawState === 'uncertain' || node.state === 'uncertain') return 'uncertain';
  if (exitCode !== null) return 'exited';
  return 'unknown';
}

/** Link wait_process / kill_process observations back to their background launch card in the same turn. */
export function linkBackgroundJobTools(children: readonly AiTurnProcessChildNode[]): AiTurnProcessChildNode[] {
  const tools = children.filter((child): child is AiToolNode => child.kind === 'tool')
    .sort((left, right) => left.firstSeq - right.firstSeq || left.lastSeq - right.lastSeq);
  const launchesByHandle = new Map<string, AiToolNode>();
  const observationsByLaunchKey = new Map<string, Array<{ node: AiToolNode; action: 'wait' | 'kill'; handle: string }>>();

  for (const tool of tools) {
    const input = asRecord(tool.input);
    const observationAction = backgroundObservationAction(tool);
    if (observationAction) {
      const handle = extractProcessHandle(tool);
      if (!handle) continue;
      const launch = launchesByHandle.get(JSON.stringify([tool.sessionId, handle]));
      if (!launch || tool.firstSeq < launch.firstSeq) continue;
      const list = observationsByLaunchKey.get(launch.key) ?? [];
      list.push({ node: tool, action: observationAction, handle });
      observationsByLaunchKey.set(launch.key, list);
      continue;
    }
    if (input?.background === true) {
      const handle = extractProcessHandle(tool);
      if (!handle) continue;
      launchesByHandle.set(JSON.stringify([tool.sessionId, handle]), tool);
    }
  }

  if (observationsByLaunchKey.size === 0) return [...children];

  const launchSummaries = new Map<string, AiBackgroundJobObservationSummary>();
  const observationLinks = new Map<string, AiBackgroundJobLink>();

  for (const [launchKey, observations] of observationsByLaunchKey) {
    let latestState: AiBackgroundJobObservationSummary['state'] = 'unknown';
    let latestExitCode: number | null = null;
    let stopRequested = false;
    let observing = false;
    let combinedOutput = '';
    let lastChunk = '';
    let latestObserverToolKey = '';
    let handle = '';

    for (const { node, action, handle: obsHandle } of observations) {
      handle = obsHandle;
      latestObserverToolKey = node.key;
      const output = asRecord(node.output);
      const job = asRecord(output?.job);
      const rawExit = firstNumber(job ?? output, ['exitCode', 'exit_code', 'code'])
        ?? firstNumber(output, ['exitCode', 'exit_code', 'code']);
      const observedState = parseObservedJobState(node, output, rawExit);
      const exitCode = observedState === 'running' ? null : rawExit;

      latestState = observedState;
      if (exitCode !== null) latestExitCode = exitCode;
      if (action === 'kill' || output?.stopRequested === true) stopRequested = true;
      observing = node.state === 'running' || node.state === 'preparing';

      const chunk = extractObservationOutput(output);
      if (chunk && chunk !== lastChunk) {
        const sep = combinedOutput && !combinedOutput.endsWith('\n') && !chunk.startsWith('\n') ? '\n' : '';
        combinedOutput = `${combinedOutput}${sep}${chunk}`;
        lastChunk = chunk;
      }

      observationLinks.set(node.key, {
        launchToolKey: launchKey,
        processHandle: obsHandle,
        action,
        observedState,
        exitCode,
      });
    }

    launchSummaries.set(launchKey, {
      processHandle: handle,
      state: latestState,
      exitCode: latestExitCode,
      output: combinedOutput,
      observing,
      ...(stopRequested ? { stopRequested: true } : {}),
      latestObserverToolKey,
      observationCount: observations.length,
    });
  }

  return children.map((child) => {
    if (child.kind !== 'tool') return child;
    const backgroundJob = launchSummaries.get(child.key);
    if (backgroundJob) return { ...child, backgroundJob };
    const linkedBackgroundJob = observationLinks.get(child.key);
    if (linkedBackgroundJob) return { ...child, linkedBackgroundJob };
    return child;
  });
}

export function storedToolOutputId(node: AiToolNode): string | undefined {
  if (typeof node.output !== 'object' || node.output === null || Array.isArray(node.output)) return;
  const output = node.output as Record<string, unknown>;
  if (output.readWith === 'read_tool_result' && typeof output.artifactRef === 'string'
    && /^artifact-[0-9a-f]{32}$/u.test(output.artifactRef)) return output.artifactRef;
}

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

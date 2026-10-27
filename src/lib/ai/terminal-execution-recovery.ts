import type { AiSessionView } from './session-adapter';
import type { LocaleKey } from '@/locales';

export interface TerminalExecutionRecovery {
  readonly reasonKey: LocaleKey;
  readonly needsStop: boolean;
}

/** A terminal recovery gate is a human action boundary, never permission to replay input. */
export function terminalExecutionRecovery(view: AiSessionView | null | undefined): TerminalExecutionRecovery | null {
  if (!view || view.summary.archived || view.snapshot.value.header.subagent
    || view.snapshot.value.header.executionSurface !== 'boundTerminal'
    || !['waiting', 'idle', 'cancelled', 'failed'].includes(view.status)) return null;
  const recovery = view.recovery ?? view.snapshot.value.recovery;
  const summary = recovery.summary ?? '';
  const reason = view.statusReason ?? '';
  if (reason !== 'terminalExecutionRecoveryRequired'
    && !reason.startsWith('TERMINAL_INPUT_RECOVERY_REQUIRED')
    && !summary.startsWith('TERMINAL_INPUT_RECOVERY_REQUIRED')) return null;
  let diagnostic = `${summary}\n${reason}`;
  for (let index = view.nodes.length - 1; index >= 0; index--) {
    const node = view.nodes[index];
    if (node.kind === 'turnProcess') {
      for (const child of [...node.children].reverse()) {
        if (child.kind !== 'tool') continue;
        const candidates = [child.error];
        if (typeof child.output === 'object' && child.output !== null
          && 'managementBlocked' in child.output && typeof child.output.managementBlocked === 'string') {
          candidates.push(child.output.managementBlocked);
        }
        const failure = candidates.find(value => value?.includes('TERMINAL_INPUT_RECOVERY_REQUIRED'));
        if (failure) { diagnostic = failure; break; }
      }
      break;
    }
  }
  const reasonKey = diagnostic.includes('private descriptor was not confirmed')
    || diagnostic.includes('private receiver was not ready')
    || diagnostic.includes('checkpoint was not confirmed')
    || diagnostic.includes('acknowledgement was lost')
    ? 'ai.workspace.terminalRecovery.confirmation'
    : diagnostic.includes('changed') || diagnostic.includes('mismatched')
      ? 'ai.workspace.terminalRecovery.editorChanged'
      : diagnostic.includes('interrupted')
        ? 'ai.workspace.terminalRecovery.interrupted'
        : 'ai.workspace.terminalRecovery.unverified';
  return { reasonKey, needsStop: view.status === 'waiting' };
}

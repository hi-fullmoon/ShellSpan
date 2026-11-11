import {nativeFileChainPathIdentity} from './native-file-chain-approval';

export function nativePowerShellRestartInvocation(path: string): string {
  if (!nativeFileChainPathIdentity(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error('Exact returned absolute Windows script path required');
  return "& '" + path.split("'").join("''") + "'";
}

export function matchesNativePowerShellRestartSource(data: Record<string, unknown>, source: string): boolean {
  const value = data.commandObservation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return data.channel === 'terminal' && data.execution === 'completed' && data.exitCode === 0
    && data.commandLine === source && proof.displaySource === source
    && (data.submittedCommandLine === null || data.submittedCommandLine === source)
    && proof.fullInputConfirmed === true && proof.submissionIntentDurable === true
    && proof.executionEvidence === 'endObserved' && proof.phase === 'completed' && proof.noAutoReplay === true;
}

export function matchesNativePowerShellRestartRecovery(before: unknown, after: unknown): boolean {
  if (!before || typeof before !== 'object' || Array.isArray(before)
    || !after || typeof after !== 'object' || Array.isArray(after)) return false;
  const original = before as Record<string, unknown>;
  const current = after as Record<string, unknown>;
  return current.open === true && current.promptReady === true && current.inputMode === 'native-inline'
    && typeof original.terminalSessionId === 'string' && original.terminalSessionId.length > 0
    && typeof original.transportSessionId === 'string' && original.transportSessionId.length > 0
    && typeof original.currentDirectory === 'string' && original.currentDirectory.length > 0
    && typeof original.terminalGeneration === 'number' && Number.isInteger(original.terminalGeneration)
    && original.terminalGeneration > 0
    && ['terminalSessionId', 'terminalGeneration', 'transportSessionId', 'currentDirectory']
      .every(key => original[key] !== undefined && current[key] === original[key]);
}

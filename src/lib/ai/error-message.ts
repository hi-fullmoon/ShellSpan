import type { LocaleKey } from '@/locales';
import { imageErrorKey } from './image-error';
import { requestErrorMessageKey } from './request-error';

/** Recognize current and persisted loopback probe diagnostics, leaving other failures intact. */
export function httpProbeTimeoutKind(message: string): 'http' | 'ssh' | null {
  const diagnostic = message.trim().replace(/^Error:\s*/, '');
  const sshTimeouts = [
    'target loopback SSH setup exceeded its total deadline',
    'target loopback SSH transport exceeded its total deadline',
  ];
  if (sshTimeouts.some(timeout => diagnostic === timeout
    || diagnostic === `Target loopback HTTP request exceeded its total deadline; ${timeout}`)) return 'ssh';
  if (diagnostic === 'Target loopback HTTP request exceeded its total deadline'
    || diagnostic === 'probe_http exceeded its total deadline'
    || diagnostic === 'Loopback HTTP probe timed out') return 'http';
  return null;
}

/** Translate recognized runtime errors without changing stored diagnostics or user content. */
export function aiErrorMessage(message: string, t: (key: LocaleKey, values?: Record<string, string | number>) => string): string {
  if (message.includes('EXECUTION_OUTCOME_UNKNOWN')) return t('ai.error.executionOutcomeUnknown');
  if (message.includes('INVALID_MODEL_TOKEN_BUDGET:')) return t('ai.error.modelInputBudgetInvalid');
  if (httpProbeTimeoutKind(message)) return t('ai.workspace.tool.httpProbe.timeout');
  const diagnostic = message.trim().replace(/^Error:\s*/, '');
  if (diagnostic.startsWith('journalWriteFailed')) return t('ai.error.journalWriteFailed');
  const taskBudget = /^taskTokenBudgetExceeded: maximum (\d+) estimated model tokens(; checkpointUnavailable)?$/.exec(diagnostic);
  if (taskBudget) {
    const summary = t('ai.error.taskTokenBudgetExceeded', { maximum: taskBudget[1] });
    return taskBudget[2] ? `${summary} ${t('ai.error.taskBudgetCheckpointUnavailable')}` : summary;
  }
  const activeTime = /^taskActiveTimeExceeded: maximum (\d+) active ms$/.exec(diagnostic);
  if (activeTime) return t('ai.error.taskActiveTimeExceeded', { seconds: Math.ceil(Number(activeTime[1]) / 1000) });
  const tokenBudget = /^subagentTokenBudgetExceeded: maximum (\d+) tokens$/.exec(diagnostic);
  if (tokenBudget) return t('ai.error.subagentTokenBudgetExceeded', { maximum: tokenBudget[1] });
  const stepLimit = /^stepLimitExceeded: maximum (\d+) Steps per Turn$/.exec(diagnostic);
  if (stepLimit) return t('ai.error.stepLimitExceeded', { maximum: stepLimit[1] });
  if (diagnostic.startsWith('stepLimitExceeded:')) return t('ai.error.stepLimitExceededGeneric');
  if (diagnostic.startsWith('ephemeralInputUnavailable:')) return t('ai.error.ephemeralInputUnavailable');
  if (diagnostic.startsWith('ephemeralInputRecoveryRequired:')) return t('ai.error.ephemeralInputRecoveryRequired');
  if (diagnostic.startsWith('childRecoveryReplayBlocked:')) return t('ai.error.childRecoveryReplayBlocked');
  if (diagnostic.startsWith('subagentBudgetExhausted:')) return t('ai.error.childRecoveryBudgetExhausted');
  const code = /^(?:Error:\s*)?([A-Z][A-Z0-9_]+)(?=:|\s|$)/.exec(message.trim())?.[1];
  if (code === 'TERMINAL_AGENT_CONFLICT') return t('terminal.occupancy.conflict');
  if (code === 'INVALID_MODEL_SELECTION') return t('ai.error.invalidModelSelection');
  if (code === 'CHILD_RETRY_UNAVAILABLE') return t('ai.error.childRetryUnavailable');
  if (code === 'MODEL_RETRY_COOLDOWN') return t('ai.error.childRetryCooldown');
  if (code === 'AGENT_PREPARATION_TIMEOUT') return t('ai.workspace.error.preparationTimeout');
  if (code === 'AGENT_CRITICAL_OPERATION_DENIED') return t('ai.error.criticalOperationDenied');
  if (code === 'AGENT_SANDBOX_DISABLED') return t('ai.error.sandboxDisabled');
  if (code === 'SANDBOX_DIRECT_REQUIRED') return t('ai.error.sandboxDirectRequired');
  if (code === 'MAC_SANDBOX_PREVIEW_DIRECT_ONLY' || code === 'MAC_SANDBOX_DIRECT_REQUIRED' || code === 'WINDOWS_SANDBOX_DIRECT_REQUIRED') return t('ai.error.localSandboxDirectRequired');
  if (code === 'MAC_SANDBOX_PREVIEW_MANAGED_ROOT_REQUIRED' || code === 'MAC_SANDBOX_MANAGED_ROOT_REQUIRED' || code === 'WINDOWS_SANDBOX_MANAGED_ROOT_REQUIRED') return t('ai.error.localSandboxManagedRoot');
  if (code === 'MAC_SANDBOX_START_FAILED' || code === 'WINDOWS_SANDBOX_START_FAILED') return t('ai.error.localSandboxStartFailed');
  if (code === 'LOCAL_SANDBOX_UNAVAILABLE' || code === 'LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE' || code === 'WINDOWS_SANDBOX_UNAVAILABLE') return t('ai.error.localSandboxUnavailable');
  if (code === 'LOCAL_SANDBOX_TERMINAL_REQUIRED') return t('ai.error.localSandboxTerminalRequired');
  if (code === 'LOCAL_SANDBOX_POLICY_DRIFT') return t('ai.error.localSandboxPolicyDrift');
  if (code === 'LOCAL_SANDBOX_LAUNCHER_CHANGED') return t('ai.error.localSandboxLauncherChanged');
  if (code === 'SANDBOX_SYNC_BUSY') return t('ai.error.sandboxSyncBusy');
  if (code === 'SANDBOX_SESSION_POLICY_CHANGED') return t('ai.error.sandboxSessionPolicyChanged');
  if (code === 'AUTO_REVIEW_CHANGED') return t('ai.error.autoReviewChanged');
  if (code === 'AGENT_UNSAFE_FILE_ROOT') return t('ai.error.unsafeFileRoot');
  if (code?.startsWith('IMAGE_')) {
    const key = imageErrorKey(code);
    if (key !== 'ai.workspace.images.error.retry') return t(key);
  }
  if (/^(?:retryable model failure|providerFailure|runtimeFailure|contextBudgetExceeded):/.test(diagnostic)
    || diagnostic === 'network recovery after model transport failure') return t(requestErrorMessageKey(diagnostic));
  return message;
}

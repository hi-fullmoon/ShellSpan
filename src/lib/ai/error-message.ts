import type { LocaleKey } from '@/locales';
import { imageErrorKey } from './image-error';

/** Translate known configuration/image errors without changing stored diagnostics. */
export function aiErrorMessage(message: string, t: (key: LocaleKey, values?: Record<string, string | number>) => string): string {
  const diagnostic = message.trim().replace(/^Error:\s*/, '');
  const sandboxDiagnostic = diagnostic.replace(/^Tool not started:\s*/, '');
  if (diagnostic.startsWith('SANDBOX_POLICY_BUSY:')) return t('agent.sandbox.policyBusy');
  if (diagnostic.startsWith('EXECUTION_SURFACE_BUSY:')) return t('agent.executionSurface.backgroundBusy');
  if (/^(?:directCleanupUnconfirmed|sandboxLocalCleanupUnconfirmed|sandboxRemoteCleanupUnconfirmed|localControllerCleanupUnconfirmed|localControllerUnavailable|localControllerPanicked)(?=:|\s|$)/.test(sandboxDiagnostic)) return t('ai.error.sandboxCleanupUnconfirmed');
  if (/^directOwnership(?:Unavailable|Invalid|RootChanged|WriteFailed|Duplicate)(?=:|\s|$)/.test(sandboxDiagnostic)) return t('ai.error.sandboxOwnershipUnavailable');
  if (sandboxDiagnostic.startsWith('sandboxBackendUnavailable:')) return t('ai.error.sandboxBackendUnavailable');
  if (sandboxDiagnostic.startsWith('sandboxAuthorizationInvalid:') || sandboxDiagnostic.startsWith('sandboxAuthorizationInvalidAfterRestart:')) return t('ai.error.sandboxAuthorizationInvalid');
  if (/^sandbox(?:WorkspaceMissing|WorkspaceInvalid|TargetMissing):/.test(sandboxDiagnostic)) return t('ai.error.sandboxWorkspaceInvalid');
  if (sandboxDiagnostic.startsWith('sandboxInheritanceDenied:')) return t('ai.error.sandboxInheritanceDenied');
  const tokenBudget = /^subagentTokenBudgetExceeded: maximum (\d+) tokens$/.exec(diagnostic);
  if (tokenBudget) return t('ai.error.subagentTokenBudgetExceeded', { maximum: tokenBudget[1] });
  if (diagnostic.startsWith('ephemeralInputUnavailable:')) return t('ai.error.ephemeralInputUnavailable');
  if (diagnostic.startsWith('ephemeralInputRecoveryRequired:')) return t('ai.error.ephemeralInputRecoveryRequired');
  const code = /^(?:Error:\s*)?([A-Z][A-Z0-9_]+)(?=:|\s|$)/.exec(message.trim())?.[1];
  if (code === 'INVALID_MODEL_SELECTION') return t('ai.error.invalidModelSelection');
  if (code === 'AGENT_CRITICAL_OPERATION_DENIED') return t('ai.error.criticalOperationDenied');
  if (code === 'AUTO_REVIEW_CHANGED') return t('ai.error.autoReviewChanged');
  if (code === 'AGENT_UNSAFE_FILE_ROOT') return t('ai.error.unsafeFileRoot');
  if (code?.startsWith('IMAGE_')) {
    const key = imageErrorKey(code);
    if (key !== 'ai.workspace.images.error.retry') return t(key);
  }
  return message;
}

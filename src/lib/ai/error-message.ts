import type { LocaleKey } from '@/locales';
import { imageErrorKey } from './image-error';

/** Translate known configuration/image errors without changing stored diagnostics. */
export function aiErrorMessage(message: string, t: (key: LocaleKey, values?: Record<string, string | number>) => string): string {
  const diagnostic = message.trim().replace(/^Error:\s*/, '');
  const tokenBudget = /^subagentTokenBudgetExceeded: maximum (\d+) tokens$/.exec(diagnostic);
  if (tokenBudget) return t('ai.error.subagentTokenBudgetExceeded', { maximum: tokenBudget[1] });
  if (diagnostic.startsWith('ephemeralInputUnavailable:')) return t('ai.error.ephemeralInputUnavailable');
  if (diagnostic.startsWith('ephemeralInputRecoveryRequired:')) return t('ai.error.ephemeralInputRecoveryRequired');
  const code = /^(?:Error:\s*)?([A-Z][A-Z0-9_]+)(?=:|\s|$)/.exec(message.trim())?.[1];
  if (code === 'INVALID_MODEL_SELECTION') return t('ai.error.invalidModelSelection');
  if (code?.startsWith('IMAGE_')) {
    const key = imageErrorKey(code);
    if (key !== 'ai.workspace.images.error.retry') return t(key);
  }
  return message;
}

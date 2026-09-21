import type { LocaleKey } from '@/locales';

/** Classify runtime diagnostics without exposing provider payloads in the summary. */
export function requestErrorMessageKey(message: string): LocaleKey {
  const text = message.toLowerCase();
  if (text.includes('model_not_found') || /model .+ does not exist/.test(text)) return 'ai.error.modelUnavailable';
  if (text.includes('semantic summary unavailable')) return 'ai.error.summaryUnavailable';
  if (/\b(401|403)\b|unauthorized|authentication|invalid_api_key/.test(text)) return 'ai.error.authentication';
  if (/\b429\b|rate.?limit/.test(text)) return 'ai.error.rateLimited';
  if (/timeout|timed out/.test(text)) return 'ai.error.timeout';
  if (/network|connection|unreachable/.test(text)) return 'ai.error.connection';
  if (/\b404\b|http_404/.test(text)) return 'ai.error.notFound';
  return 'ai.error.generic';
}

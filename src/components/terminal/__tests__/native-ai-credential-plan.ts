import type {ProviderRoute} from '@/types/ai';
export function ownedAiCredentialRoute(runId: string): ProviderRoute {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) throw Error('Owned AI credential run ID required');
  return {id: 'e07-ai-' + runId, revision: 0, displayName: 'E07 owned credential', adapterId: 'chat-completions', baseUrl: 'https://api.minimaxi.com', auth: {kind: 'none'}, replayDomainId: 'e07-' + runId, presetId: 'minimax', retryPolicy: {maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30000, jitterRatio: 0.2}, timeouts: {requestHeadersMs: 30000, firstByteMs: 30000, streamIdleMs: 300000}};
}
export function isMissingAiCredential(error: unknown): boolean {
  return error === 'MISSING_CREDENTIAL' || error instanceof Error && error.message === 'MISSING_CREDENTIAL';
}
export function assertOwnedAiReference(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^llm-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw Error('Generated owned AI credential reference required');
}

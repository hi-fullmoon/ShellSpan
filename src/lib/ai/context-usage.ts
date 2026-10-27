import type { AgentSessionEvent } from '@/types/agent-session';
import type { AiContextUsage } from './session-adapter';

const validCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

/** Replay one session's committed accounting; estimates never replace a confirmed input. */
export function projectContextUsage(events: readonly AgentSessionEvent[]): AiContextUsage | undefined {
  let generation = -1;
  let contextWindow: number | undefined;
  let estimatedTokens: number | undefined;
  let breakdown: AiContextUsage['breakdown'];
  let afterCompaction = false;
  let reported: { requestSeq: number; tokens: number } | undefined;
  const requests = new Map<string, number>();
  const advance = (next: number): void => {
    if (next <= generation) return;
    afterCompaction = generation >= 0 || next > 0;
    generation = next;
    estimatedTokens = undefined;
    breakdown = undefined;
    reported = undefined;
    requests.clear();
  };

  for (const event of events) {
    if (event.type === 'compaction/summary'
      || (event.type === 'compaction/end' && event.data.status === 'completed')) {
      advance(event.data.surfaceGeneration);
    } else if (event.type === 'request/context') {
      if (event.data.surfaceGeneration < generation) continue;
      advance(event.data.surfaceGeneration);
      requests.set(event.data.requestId, event.seq);
      if (validCount(event.data.contextWindow) && event.data.contextWindow > 0) {
        contextWindow = event.data.contextWindow;
      }
      estimatedTokens = validCount(event.data.inputTokens) ? event.data.inputTokens : undefined;
      const { systemTokens, toolSchemaTokens: toolsTokens, messageTokens } = event.data;
      breakdown = validCount(systemTokens) && validCount(toolsTokens) && validCount(messageTokens)
        ? { systemTokens, toolsTokens, messageTokens } : undefined;
    } else if (event.type === 'request/usage') {
      const requestSeq = requests.get(event.data.requestId);
      const { uncachedInputTokens, cacheReadTokens } = event.data.usage;
      if (requestSeq === undefined || requestSeq > event.seq
        || requestSeq < (reported?.requestSeq ?? -1)
        || !validCount(uncachedInputTokens) || !validCount(cacheReadTokens)) continue;
      const tokens = uncachedInputTokens + cacheReadTokens;
      if (!Number.isFinite(tokens)) continue;
      reported = { requestSeq, tokens };
    }
  }
  if (contextWindow === undefined) return undefined;
  const details = {
    contextWindow,
    ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
    ...(breakdown === undefined ? {} : { breakdown }),
    ...(afterCompaction && !reported ? { afterCompaction: true } : {}),
  };
  if (reported) return { ...details, usedTokens: reported.tokens, source: 'reported' };
  if (estimatedTokens !== undefined) return { ...details, usedTokens: estimatedTokens, source: 'estimated' };
  return { ...details, usedTokens: null, source: 'pending' };
}

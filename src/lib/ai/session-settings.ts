import type { AgentSubagentModel } from '@/types/agent-session';
import type { AiProviderConfig } from '@/types/ai';
import type { AiContextUsage } from './session-adapter';

/** Keep recorded usage intact while reflecting the current model's capacity. */
export function contextUsageForModel(
  usage: AiContextUsage | undefined,
  contextWindow: number | undefined,
): AiContextUsage | undefined {
  if (!usage || contextWindow === undefined || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0 || contextWindow === usage.contextWindow) return usage;
  return { ...usage, contextWindow, capacitySource: 'selectedModel' };
}

/** Restore the credential-free provider selection recorded by the runtime. */
export function sessionProviderConfig(selection: AgentSubagentModel, providers: readonly AiProviderConfig[] = []): AiProviderConfig {
  const current = providers.find(p => p.id === selection.routeId && p.model === selection.modelId);
  if (!current) throw new Error(`INVALID_MODEL_SELECTION: ${selection.routeId}/${selection.modelId}`);
  if (selection.routeRevision !== undefined && current.routeRevision !== selection.routeRevision) {
    throw new Error(`INVALID_MODEL_SELECTION: stale route revision ${selection.routeRevision}`);
  }
  return { ...current, routeRevision: selection.routeRevision ?? current.routeRevision, reasoningEffort: selection.reasoningEffort };
}

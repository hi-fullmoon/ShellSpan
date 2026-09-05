import type { AgentSubagentModel } from '@/types/agent-session';
import type { AiProviderConfig } from '@/types/ai';

/** Restore the credential-free provider selection recorded by the runtime. */
export function sessionProviderConfig(selection: AgentSubagentModel, providers: readonly AiProviderConfig[] = []): AiProviderConfig {
  const current = providers.find(p => p.id === selection.routeId && p.model === selection.modelId);
  if (!current) throw new Error(`INVALID_MODEL_SELECTION: ${selection.routeId}/${selection.modelId}`);
  if (selection.routeRevision !== undefined && current.routeRevision !== selection.routeRevision) {
    throw new Error(`INVALID_MODEL_SELECTION: stale route revision ${selection.routeRevision}`);
  }
  return { ...current, routeRevision: selection.routeRevision ?? current.routeRevision, reasoningEffort: selection.reasoningEffort };
}

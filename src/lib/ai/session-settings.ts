import type { AgentSubagentModel } from '@/types/agent-session';
import type { AiProviderConfig } from '@/types/ai';

/** Restore the credential-free provider selection recorded by the runtime. */
export function sessionProviderConfig(selection: AgentSubagentModel): AiProviderConfig {
  return {
    id: selection.providerId,
    kind: selection.providerKind,
    baseUrl: selection.baseUrl,
    model: selection.model,
    profile: selection.profile as AiProviderConfig['profile'],
    reasoningEffort: selection.reasoningEffort as AiProviderConfig['reasoningEffort'],
    requiresApiKey: selection.requiresApiKey,
    retryPolicy: selection.retryPolicy,
  };
}

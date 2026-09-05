// Test-only IPC responses, checked byte-for-byte against Rust resolution.
import fixtures from '../../protocol/llm/fixtures/resolved-models.json';
import type { AiProviderConfig } from '@/types/ai';
import type { ResolvedModel } from '@/lib/ai/provider-contract';

export async function fixtureResolve(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command !== 'ai_resolve_model') return undefined;
  const provider = args?.provider as AiProviderConfig;
  const fixture = fixtures.find(f => f.provider.model === provider.model && f.provider.kind === provider.kind
    && (!provider.profile || f.provider.profile === provider.profile));
  if (!fixture && !provider.modelDefinition) throw new Error('UNKNOWN_MODEL: explicit declaration required');
  const model = { ...(fixture?.resolved ?? {}), ...provider.modelDefinition,
    kind: provider.kind, routeId: provider.id, providerId: provider.id, modelId: provider.model,
    source: provider.modelDefinition ? 'userDeclaration' : 'builtinCatalog' } as ResolvedModel;
  if (provider.reasoningEffort && !model.reasoning.some(o => o.id === provider.reasoningEffort)) throw new Error('UNSUPPORTED_REASONING_EFFORT');
  return structuredClone(model);
}

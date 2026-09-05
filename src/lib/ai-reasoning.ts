import type { AiProviderProfile, AiReasoningOption } from '@/types/ai';
import { providerCapabilities } from './provider-contract';
type Provider = Pick<AiProviderProfile, 'kind' | 'preset' | 'baseUrl' | 'model' | 'profile' | 'modelDefinition' | 'id'>;
export interface AiReasoningCapability { kind: 'none' | 'toggle' | 'effort'; options: readonly AiReasoningOption[] }
export function isAiReasoningOption(value: unknown): value is AiReasoningOption {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
export function reasoningCapability(provider: Provider): AiReasoningCapability {
  const options = providerCapabilities(provider).reasoningOptions;
  return { kind: !options.length ? 'none' : options.includes('on') ? 'toggle' : 'effort', options };
}
export function reasoningEffortOptions(provider: Provider): readonly AiReasoningOption[] {
  return reasoningCapability(provider).options;
}
export function effectiveReasoningEffort(provider: Provider & Pick<AiProviderProfile, 'reasoningEffort'>): AiReasoningOption | undefined {
  return provider.reasoningEffort && reasoningEffortOptions(provider).includes(provider.reasoningEffort)
    ? provider.reasoningEffort : undefined;
}

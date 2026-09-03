import type { AiProviderProfile, AiReasoningEffort, AiReasoningOption } from '@/types/ai';
import { providerCapabilities, resolveProviderProfile } from './provider-contract';
type Provider = Pick<AiProviderProfile, 'kind' | 'preset' | 'baseUrl' | 'model' | 'profile'>;
export const KIMI_K3_REASONING_EFFORTS: readonly AiReasoningEffort[] = ['low', 'high', 'max'];
export interface AiReasoningCapability { kind: 'none' | 'toggle' | 'effort'; options: readonly AiReasoningOption[] }
export function isAiReasoningOption(value: unknown): value is AiReasoningOption {
  return ['off', 'on', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value as string);
}
export function isKimiK3Provider(provider: Provider): boolean {
  return resolveProviderProfile(provider) === 'kimi' && /^k3(?:-|$)/.test(provider.model.trim().toLowerCase());
}
export function isMiniMaxM3Provider(provider: Provider): boolean {
  return resolveProviderProfile(provider) === 'minimax' && /^minimax-m3(?:-|$)/.test(provider.model.trim().toLowerCase());
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

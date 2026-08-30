import type { AiProviderProfile, AiReasoningEffort } from '@/types/ai';

export const KIMI_K3_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'low',
  'high',
  'max',
];

export const DEFAULT_KIMI_K3_REASONING_EFFORT: AiReasoningEffort = 'high';

export function isAiReasoningEffort(value: unknown): value is AiReasoningEffort {
  return KIMI_K3_REASONING_EFFORTS.includes(value as AiReasoningEffort);
}

export function isKimiK3Provider(
  provider: Pick<AiProviderProfile, 'preset' | 'baseUrl' | 'model'>,
): boolean {
  const model = provider.model.trim().toLowerCase();
  if (model !== 'k3' && !model.startsWith('k3-')) return false;
  if (provider.preset === 'kimi') return true;

  try {
    const url = new URL(provider.baseUrl.trim());
    return url.hostname.toLowerCase() === 'api.kimi.com'
      && (url.pathname === '/coding' || url.pathname.startsWith('/coding/'));
  } catch {
    return false;
  }
}

export function reasoningEffortOptions(
  provider: Pick<AiProviderProfile, 'preset' | 'baseUrl' | 'model'>,
): readonly AiReasoningEffort[] {
  return isKimiK3Provider(provider) ? KIMI_K3_REASONING_EFFORTS : [];
}

export function effectiveReasoningEffort(
  provider: Pick<AiProviderProfile, 'preset' | 'baseUrl' | 'model' | 'reasoningEffort'>,
): AiReasoningEffort | undefined {
  if (!isKimiK3Provider(provider)) return undefined;
  return isAiReasoningEffort(provider.reasoningEffort)
    ? provider.reasoningEffort
    : DEFAULT_KIMI_K3_REASONING_EFFORT;
}

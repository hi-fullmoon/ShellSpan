import type {
  AiProviderProfile,
  AiReasoningEffort,
  AiReasoningOption,
} from '@/types/ai';

export const KIMI_K3_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'low',
  'high',
  'max',
];

const DEEPSEEK_V4_REASONING_OPTIONS: readonly AiReasoningOption[] = [
  'off',
  'low',
  'high',
  'max',
];

const OPENAI_GPT_5_6_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const OPENAI_GPT_5_4_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
];

const OPENAI_GPT_5_1_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
];

const OPENAI_GPT_5_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

const OPENAI_O_SERIES_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'low',
  'medium',
  'high',
];

const OLLAMA_THINKING_TOGGLE_OPTIONS: readonly AiReasoningOption[] = ['off', 'on'];
const OLLAMA_GPT_OSS_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'low',
  'medium',
  'high',
];

const AI_REASONING_OPTIONS: readonly AiReasoningOption[] = [
  'off',
  'on',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface AiReasoningCapability {
  kind: 'none' | 'toggle' | 'effort';
  options: readonly AiReasoningOption[];
}

const NO_REASONING_CONTROL: AiReasoningCapability = {
  kind: 'none',
  options: [],
};

// Provider model-list responses do not consistently describe reasoning controls.
// Keep this allow-list conservative so unknown compatible services stay on their
// own defaults instead of receiving a parameter they may reject.

export function isAiReasoningOption(value: unknown): value is AiReasoningOption {
  return AI_REASONING_OPTIONS.includes(value as AiReasoningOption);
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

function providerHostname(provider: Pick<AiProviderProfile, 'baseUrl'>): string | undefined {
  try {
    return new URL(provider.baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isDeepSeekV4Provider(
  provider: Pick<AiProviderProfile, 'preset' | 'baseUrl' | 'model'>,
): boolean {
  const model = provider.model.trim().toLowerCase();
  return (model === 'deepseek-v4' || model.startsWith('deepseek-v4-'))
    && (provider.preset === 'deepseek' || providerHostname(provider) === 'api.deepseek.com');
}

function openAiReasoningEfforts(model: string): readonly AiReasoningEffort[] {
  if (model === 'gpt-5.6' || model.startsWith('gpt-5.6-')) {
    return OPENAI_GPT_5_6_REASONING_EFFORTS;
  }
  if (/^gpt-5\.(4|5)(?:-|$)/.test(model)) {
    return OPENAI_GPT_5_4_REASONING_EFFORTS;
  }
  if (model === 'gpt-5.1' || model.startsWith('gpt-5.1-')) {
    return OPENAI_GPT_5_1_REASONING_EFFORTS;
  }
  if (model === 'gpt-5' || model.startsWith('gpt-5-')) {
    return OPENAI_GPT_5_REASONING_EFFORTS;
  }
  if (/^(o1|o3|o4-mini)(?:-|$)/.test(model) && !model.includes('-pro')) {
    return OPENAI_O_SERIES_REASONING_EFFORTS;
  }
  return [];
}

function ollamaReasoningCapability(model: string): AiReasoningCapability {
  if (model === 'gpt-oss' || model.startsWith('gpt-oss:') || model.startsWith('gpt-oss-')) {
    return { kind: 'effort', options: OLLAMA_GPT_OSS_REASONING_EFFORTS };
  }
  if (
    model === 'qwen3'
    || model.startsWith('qwen3:')
    || model.startsWith('qwen3-')
    || model === 'deepseek-r1'
    || model.startsWith('deepseek-r1:')
    || model.startsWith('deepseek-r1-')
    || model === 'deepseek-v3.1'
    || model.startsWith('deepseek-v3.1:')
    || model.startsWith('deepseek-v3.1-')
  ) {
    return { kind: 'toggle', options: OLLAMA_THINKING_TOGGLE_OPTIONS };
  }
  return NO_REASONING_CONTROL;
}

export function reasoningCapability(
  provider: Pick<AiProviderProfile, 'kind' | 'preset' | 'baseUrl' | 'model'>,
): AiReasoningCapability {
  if (isKimiK3Provider(provider)) {
    return { kind: 'effort', options: KIMI_K3_REASONING_EFFORTS };
  }
  if (isDeepSeekV4Provider(provider)) {
    return { kind: 'effort', options: DEEPSEEK_V4_REASONING_OPTIONS };
  }
  const model = provider.model.trim().toLowerCase();
  if (
    provider.kind === 'openAi'
    && (provider.preset === 'openai' || providerHostname(provider) === 'api.openai.com')
  ) {
    const options = openAiReasoningEfforts(model);
    return options.length > 0 ? { kind: 'effort', options } : NO_REASONING_CONTROL;
  }
  if (provider.kind === 'ollama') return ollamaReasoningCapability(model);
  return NO_REASONING_CONTROL;
}

export function reasoningEffortOptions(
  provider: Pick<AiProviderProfile, 'kind' | 'preset' | 'baseUrl' | 'model'>,
): readonly AiReasoningOption[] {
  return reasoningCapability(provider).options;
}

export function effectiveReasoningEffort(
  provider: Pick<
    AiProviderProfile,
    'kind' | 'preset' | 'baseUrl' | 'model' | 'reasoningEffort'
  >,
): AiReasoningOption | undefined {
  const options = reasoningEffortOptions(provider);
  return isAiReasoningOption(provider.reasoningEffort)
    && options.includes(provider.reasoningEffort)
    ? provider.reasoningEffort
    : undefined;
}

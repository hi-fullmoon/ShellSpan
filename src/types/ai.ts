import type { ProviderProfileId } from '@/lib/provider-contract';
import type { AiRetryPolicy } from '@/lib/retry-policy';
export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible';
export type AiProviderPreset = 'ollama' | 'openai' | 'deepseek' | 'minimax' | 'kimi' | 'qwen' | 'glm' | 'custom';
export type AiReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export type AiReasoningOption = 'off' | 'on' | AiReasoningEffort;

export interface AiProviderConfig {
  retryPolicy?: AiRetryPolicy;
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  profile?: ProviderProfileId;
  reasoningEffort?: AiReasoningOption;
  requiresApiKey: boolean;
}

/** Used only while testing a provider setup; the key is never persisted. */
export interface AiProviderConnectionConfig extends AiProviderConfig {
  apiKey?: string;
}

export interface AiProviderProfile extends AiProviderConfig {
  name: string;
  preset: AiProviderPreset;
}

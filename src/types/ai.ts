export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible';
export type AiProviderPreset = 'ollama' | 'openai' | 'deepseek' | 'minimax' | 'kimi' | 'custom';
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
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
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

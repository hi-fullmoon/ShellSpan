import type { ProviderProfileId } from '@/lib/provider-contract';
import type { AiRetryPolicy } from '@/lib/retry-policy';
export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible' | 'anthropicMessages';
export type AiProviderPreset = 'ollama' | 'openai' | 'anthropic' | 'deepseek' | 'minimax' | 'kimi' | 'qwen' | 'glm' | 'custom';
export type AiReasoningEffort = string;
export type AiReasoningOption = string;

export interface AiProviderConfig {
  /** Route revision used to validate an existing Session selection. */
  routeRevision?: number;
  modelDefinition?: import('@/lib/provider-contract').ModelDefinition;
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

export interface ModelSelection { routeId: string; modelId: string; reasoningEffort?: string }
export interface ProviderRoute {
  id: string; revision: number; displayName: string;
  adapterId: 'responses' | 'chat-completions' | 'ollama' | 'anthropic-messages'; baseUrl: string;
  auth: { kind: 'none' } | { kind: 'keychain'; reference: string };
  replayDomainId: string; presetId?: string;
  models?: Record<string, import('@/lib/provider-contract').ModelDefinition>;
  modelOverrides?: Record<string, import('@/lib/provider-contract').ModelDefinition>;
  defaults?: ModelSelection; retryPolicy: AiRetryPolicy;
  timeouts: { requestHeadersMs: number; firstByteMs: number; streamIdleMs: number };
}
export interface RouteSnapshot {
  schemaVersion: 1; revision: number; routes: ProviderRoute[]; defaultSelection?: ModelSelection;
  migrationComplete: boolean; migrationIssues: { original: unknown; error: string }[];
}

import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AiProviderConfig, AiProviderPreset, AiProviderKind, AiReasoningOption } from '@/types/ai';

// Presentation identities only. All model facts come from ai_resolve_model.
export const PROVIDER_PROFILE_IDS = ['openai', 'anthropic', 'ollama', 'deepseek', 'minimax', 'qwen', 'glm', 'kimi', 'generic'] as const;
export type ProviderProfileId = typeof PROVIDER_PROFILE_IDS[number];
export type Support = 'supported' | 'unsupported' | 'unknown';
export interface ModelCompat {
  protocol: AiProviderKind;
  cumulativeStream: boolean; supportsStreamUsage: boolean; nativeReasoning: boolean;
  splitReasoning: boolean; replayReasoningContent: boolean; thinkTagFallback: boolean;
  parallelToolCalls: boolean; strictSchema: boolean; preservesReasoningAcrossTurns: boolean;
  reasoningEncoding: 'none' | 'responses' | 'enableThinking' | 'thinking' | 'adaptive' | 'thinkingEffort' | 'effort' | 'ollama' | 'anthropicAdaptive';
  clearThinking: boolean; defaultThinking: boolean;
}
export interface VisionBudget {
  maxRequestImages: number; maxRequestImageBytes: number; reservedTokensPerImage: number;
  imageTokenBudgetPolicy: string;
}
export interface ModelDefinition {
  contextWindow: number; maxOutputTokens: number;
  toolCalling: Support; textInput: Support; imageInput: Support;
  reasoning: { id: string; displayName: string }[];
  compat: ModelCompat; vision?: VisionBudget;
}
export interface ResolvedModel extends ModelDefinition {
  catalogVersion: number; routeId: string; providerId: string; profile: ProviderProfileId;
  kind: AiProviderKind; modelId: string; source: 'builtinCatalog' | 'userDeclaration'; capacityPolicy: string;
}
type Provider = Pick<AiProviderConfig, 'kind' | 'model' | 'baseUrl' | 'profile' | 'modelDefinition'> & { preset?: AiProviderPreset; id?: string };
export function isProviderProfile(value: unknown): value is ProviderProfileId {
  return typeof value === 'string' && PROVIDER_PROFILE_IDS.includes(value as ProviderProfileId);
}
// No domain inference. Missing legacy profile is retained for the backend conversion boundary.
export function resolveProviderProfile(provider: Provider): ProviderProfileId | undefined {
  return provider.profile ?? (provider.preset && provider.preset !== 'custom' ? provider.preset : undefined);
}
export function profileProtocol(profile: ProviderProfileId): AiProviderKind {
  return profile === 'openai' ? 'openAi' : profile === 'anthropic' ? 'anthropicMessages' : profile === 'ollama' ? 'ollama' : 'openAiCompatible';
}
export type ModelResolution = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; model: ResolvedModel };
const unresolved: ModelResolution = { status: 'loading' };
const cache = new Map<string, ModelResolution>();
const pending = new Map<string, Promise<ResolvedModel>>();
const listeners = new Set<() => void>();
function capabilityConfig(provider: Provider): AiProviderConfig {
  return { id: provider.id ?? 'draft', kind: provider.kind, model: provider.model, baseUrl: provider.baseUrl,
    profile: resolveProviderProfile(provider), modelDefinition: provider.modelDefinition, requiresApiKey: false };
}
export function modelResolutionKey(provider: Provider): string { return JSON.stringify(capabilityConfig(provider)); }
function publish(key: string, value: ModelResolution) { cache.set(key, value); listeners.forEach(listener => listener()); }
export function modelResolution(provider: Provider): ModelResolution { return cache.get(modelResolutionKey(provider)) ?? unresolved; }
export function loadResolvedModel(provider: Provider, retry = false): Promise<ResolvedModel> {
  const key = modelResolutionKey(provider);
  const existing = cache.get(key);
  if (!retry && existing?.status === 'ready') return Promise.resolve(existing.model);
  if (pending.has(key)) return pending.get(key)!;
  publish(key, unresolved);
  const promise = invoke<ResolvedModel>('ai_resolve_model', { provider: capabilityConfig(provider) }).then(model => {
    if (!model || model.modelId !== provider.model || model.routeId !== (provider.id ?? 'draft') || model.kind !== provider.kind) throw new Error('MODEL_RESOLUTION_INVALID: backend model identity mismatch');
    publish(key, { status: 'ready', model }); return model;
  }).catch(error => { publish(key, { status: 'error', error: String(error) }); throw error; }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
export function useResolvedModel(provider: Provider | undefined): ModelResolution {
  const key = provider ? modelResolutionKey(provider) : undefined;
  const state = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => key ? cache.get(key) ?? unresolved : unresolved);
  useEffect(() => { if (provider) void loadResolvedModel(provider).catch(() => {}); }, [key]);
  return state;
}
export function providerCapabilities(provider: Provider) {
  const state = modelResolution(provider);
  const model = state.status === 'ready' ? state.model : undefined;
  return { ...model?.compat, status: state.status, kind: model?.kind ?? provider.kind, profile: model?.profile,
    contextWindow: model?.contextWindow, maxOutputTokens: model?.maxOutputTokens,
    reasoningOptions: (model?.reasoning.map(option => option.id) ?? []),
    vision: model?.imageInput === 'supported' ? model.vision : undefined };
}
export function validateProviderCapabilities(provider: Provider & Pick<AiProviderConfig, 'reasoningEffort'>): void {
  const state = modelResolution(provider);
  if (state.status !== 'ready') throw new Error(state.status === 'error' ? state.error : 'MODEL_RESOLUTION_PENDING');
  if (state.model.kind !== provider.kind) throw new Error('Provider profile does not match protocol');
  if (provider.reasoningEffort && !state.model.reasoning.some(o => o.id === provider.reasoningEffort)) throw new Error('UNSUPPORTED_REASONING_EFFORT: Unsupported reasoning option');
}

import contract from './provider-contract.json';
import vision from './vision-contract.json';
import type { AiProviderConfig, AiProviderPreset, AiProviderKind, AiReasoningOption } from '@/types/ai';

export type ProviderProfileId = keyof typeof contract.profiles;
type Provider = Pick<AiProviderConfig, 'kind' | 'model' | 'baseUrl' | 'profile'> & { preset?: AiProviderPreset; id?: string };
export const PROVIDER_PROFILE_IDS = Object.keys(contract.profiles) as ProviderProfileId[];
export function isProviderProfile(value: unknown): value is ProviderProfileId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(contract.profiles, value);
}
export function resolveProviderProfile(provider: Provider): ProviderProfileId {
  if (provider.profile) return provider.profile;
  if (provider.preset && provider.preset !== 'custom') return provider.preset;
  if (provider.kind === 'openAi') return 'openai';
  if (provider.kind === 'ollama') return 'ollama';
  let host = '';
  try { host = new URL(provider.baseUrl.trim()).hostname.toLowerCase(); } catch { /* URL validation owns errors. */ }
  return PROVIDER_PROFILE_IDS.find(id => contract.profiles[id].hosts.some(h =>
    h.startsWith('.') ? host.endsWith(h) : host === h)) ?? 'generic';
}
export function providerCapabilities(provider: Provider) {
  const profile = resolveProviderProfile(provider);
  const capability = contract.profiles[profile];
  const model = provider.model.trim().toLowerCase();
  let contextHint: number | undefined;
  for (const value of [model, provider.id?.toLowerCase() ?? '']) {
    for (const marker of ['context-', 'ctx-']) {
      const offset = value.indexOf(marker);
      const digits = offset < 0 ? undefined : /^\d+/.exec(value.slice(offset + marker.length))?.[0];
      if (digits && Number.isSafeInteger(Number(digits))) {
        contextHint = Math.max(8192, Math.min(2097152, Number(digits)));
        break;
      }
    }
    if (contextHint !== undefined) break;
  }
  const rule = capability.reasoningRules.find(r => r.prefixes.some(p =>
    model === p || ['-', '.', ':'].some(separator => model.startsWith(p + separator)))
    && !r.exclude.some(part => model.includes(part)));
  return { version: contract.version, profile, ...capability, kind: capability.kind as AiProviderKind,
    contextWindow: contextHint ?? vision.routes.find(r => r.profile === profile && r.kind === provider.kind && r.models.includes(model))?.contextWindow ?? capability.contextRules.find(r => r.prefixes.some(p => model.startsWith(p)))?.tokens ?? capability.contextWindow,
    preservesReasoningAcrossTurns: capability.preservesReasoningAcrossTurns,
    nativeReasoning: profile === 'qwen' && model.includes('instruct') ? false : capability.nativeReasoning,
    reasoningOptions: (rule?.options ?? []) as AiReasoningOption[], reasoningEncoding: rule?.encoding ?? 'none' };
}
export function validateProviderCapabilities(provider: Provider & Pick<AiProviderConfig, 'reasoningEffort'>): void {
  const caps = providerCapabilities(provider);
  if (caps.kind !== provider.kind) throw new Error('Provider profile does not match protocol');
  if (provider.reasoningEffort && !caps.reasoningOptions.includes(provider.reasoningEffort)) {
    throw new Error(`Unsupported reasoning option ${provider.reasoningEffort} for ${caps.profile}/${provider.model}`);
  }
}

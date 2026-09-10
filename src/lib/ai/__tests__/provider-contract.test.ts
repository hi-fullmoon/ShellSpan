vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/test/llm-resolver-fixture')).fixtureResolve }));
import { describe, it, expect, vi } from 'vitest';
import { providerCapabilities, resolveProviderProfile, validateProviderCapabilities, loadResolvedModel } from '../provider-contract';
import fixtures from './provider-contract-fixtures.json';
import type { AiProviderConfig } from '@/types/ai';

describe('shared provider contract', async () => {
  it.each(fixtures)('explicit $provider.profile survives proxy routing', async ({ provider }) => {
    const config = provider as AiProviderConfig;
    await loadResolvedModel(config);
    expect(resolveProviderProfile(config)).toBe(provider.profile);
    expect(() => validateProviderCapabilities(config)).not.toThrow();
    expect(providerCapabilities(config).kind).toBe(provider.kind);
  });
  it('uses explicit profiles and never infers one from a URL', () => {
    const provider = fixtures[0].provider as AiProviderConfig;
    expect(resolveProviderProfile({ ...provider, profile: 'generic', baseUrl: 'https://api.deepseek.com' })).toBe('generic');
  });
  it('rejects unsupported fields and separates Qwen parsing from thinking control', async () => {
    const qwen = fixtures[5].provider as AiProviderConfig;
    await loadResolvedModel(qwen);
    await loadResolvedModel(fixtures[6].provider as AiProviderConfig);
    expect(providerCapabilities(qwen)).toMatchObject({ nativeReasoning: true, reasoningOptions: [], preservesReasoningAcrossTurns: false });
    expect(() => validateProviderCapabilities({ ...qwen, reasoningEffort: 'off' })).toThrow('Unsupported');
    expect(providerCapabilities(fixtures[6].provider as AiProviderConfig).nativeReasoning).toBe(false);
    await expect(loadResolvedModel({ ...qwen, profile: 'openai' })).rejects.toThrow('UNKNOWN_MODEL');
  });
});

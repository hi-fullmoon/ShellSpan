vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/test/llm-resolver-fixture')).fixtureResolve }));
import { describe, it, expect, vi } from 'vitest';
import { providerCapabilities, resolveProviderProfile, validateProviderCapabilities, loadResolvedModel } from '../provider-contract';
import fixtures from './provider-contract-fixtures.json';
import type { AiProviderConfig } from '@/types/ai';
import { parseAiPreferences } from '@/stores/aiSettingsStore';

describe('shared provider contract', async () => {
  it.each(fixtures)('explicit $provider.profile survives proxy routing', async ({ provider }) => {
    const config = provider as AiProviderConfig;
    await loadResolvedModel(config);
    expect(resolveProviderProfile(config)).toBe(provider.profile);
    expect(() => validateProviderCapabilities(config)).not.toThrow();
    expect(providerCapabilities(config).kind).toBe(provider.kind);
  });
  it('migrates named presets before URL and persists an explicit generic selection', async () => {
    const [base] = fixtures;
    const stored = [{ ...base.provider, kind: 'openAiCompatible', profile: undefined,
      preset: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }];
    const prefs = parseAiPreferences([['ai.providers', JSON.stringify(stored)]]);
    expect(prefs.providers[0].profile).toBe('deepseek');
    await loadResolvedModel(prefs.providers[0]);
    expect(providerCapabilities(prefs.providers[0]).reasoningOptions).toContain('high');
    expect(resolveProviderProfile({ ...prefs.providers[0], profile: 'generic', baseUrl: 'https://api.deepseek.com' })).toBe('generic');
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

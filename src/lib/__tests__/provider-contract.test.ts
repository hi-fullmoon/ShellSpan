import { describe, it, expect } from 'vitest';
import { providerCapabilities, resolveProviderProfile, validateProviderCapabilities } from '../provider-contract';
import fixtures from './provider-contract-fixtures.json';
import type { AiProviderConfig } from '@/types/ai';
import { parseAiPreferences } from '@/stores/aiSettingsStore';

describe('shared provider contract', () => {
  it.each(fixtures)('explicit $provider.profile survives proxy routing', ({ provider }) => {
    const config = provider as AiProviderConfig;
    expect(resolveProviderProfile(config)).toBe(provider.profile);
    expect(() => validateProviderCapabilities(config)).not.toThrow();
    expect(providerCapabilities(config).kind).toBe(provider.kind);
  });
  it('migrates named presets before URL and persists an explicit generic selection', () => {
    const [base] = fixtures;
    const stored = [{ ...base.provider, kind: 'openAiCompatible', profile: undefined,
      preset: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }];
    const prefs = parseAiPreferences([['ai.providers', JSON.stringify(stored)]]);
    expect(prefs.providers[0].profile).toBe('deepseek');
    expect(providerCapabilities(prefs.providers[0]).reasoningOptions).toContain('high');
    expect(resolveProviderProfile({ ...prefs.providers[0], profile: 'generic', baseUrl: 'https://api.deepseek.com' })).toBe('generic');
  });
  it('rejects unsupported fields and separates Qwen parsing from thinking control', () => {
    const qwen = fixtures[5].provider as AiProviderConfig;
    expect(providerCapabilities(qwen)).toMatchObject({ nativeReasoning: true, reasoningOptions: [], preservesReasoningAcrossTurns: false });
    expect(() => validateProviderCapabilities({ ...qwen, reasoningEffort: 'off' })).toThrow('Unsupported');
    expect(providerCapabilities(fixtures[6].provider as AiProviderConfig).nativeReasoning).toBe(false);
    expect(() => validateProviderCapabilities({ ...qwen, profile: 'openai' })).toThrow('protocol');
  });
});

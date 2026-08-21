import { beforeEach, describe, expect, it } from 'vitest';
import { parseAiPreferences, useAiSettingsStore } from '../aiSettingsStore';

const initialState = useAiSettingsStore.getState();

function preference(key: string, value: unknown): [string, string] {
  return [`ai.${key}`, JSON.stringify(value)];
}

describe('aiSettingsStore', () => {
  beforeEach(() => {
    useAiSettingsStore.setState(initialState, true);
  });

  it('migrates the legacy single-provider preferences without losing values', () => {
    const preferences = parseAiPreferences([
      preference('providerKind', 'openAi'),
      preference('ollamaBaseUrl', 'http://localhost:11434'),
      preference('ollamaModel', 'qwen2.5'),
      preference('openAiBaseUrl', 'https://gateway.example.com/v1'),
      preference('openAiModel', 'gpt-custom'),
      preference('contextLines', 500),
    ]);

    expect(preferences.defaultProviderId).toBe('openai');
    expect(preferences.contextLines).toBe(500);
    expect(preferences.providers).toEqual([
      expect.objectContaining({
        id: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5',
      }),
      expect.objectContaining({
        id: 'openai',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'gpt-custom',
      }),
    ]);
  });

  it('loads multiple providers and repairs an invalid default', () => {
    const providers = [
      {
        id: 'deepseek-primary',
        name: 'DeepSeek Primary',
        preset: 'deepseek',
        kind: 'openAiCompatible',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        requiresApiKey: true,
        structuredOutput: 'jsonObject',
      },
      {
        id: 'local',
        name: 'Local Ollama',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3',
        requiresApiKey: false,
        structuredOutput: 'jsonSchema',
      },
    ];
    const preferences = parseAiPreferences([
      preference('providers', providers),
      preference('defaultProviderId', 'missing'),
    ]);

    expect(preferences.providers).toHaveLength(2);
    expect(preferences.defaultProviderId).toBe('deepseek-primary');
  });

  it('adds a preset and exposes it as the selected request config', () => {
    const id = useAiSettingsStore.getState().addProvider('deepseek');
    useAiSettingsStore.getState().setDefaultProvider(id);

    expect(useAiSettingsStore.getState().getProviderConfig()).toEqual({
      id,
      kind: 'openAiCompatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      requiresApiKey: true,
      structuredOutput: 'jsonObject',
    });
  });

  it('moves the default when deleting a provider and always retains one provider', () => {
    useAiSettingsStore.getState().setDefaultProvider('openai');
    useAiSettingsStore.getState().removeProvider('openai');

    expect(useAiSettingsStore.getState().defaultProviderId).toBe('ollama');
    expect(useAiSettingsStore.getState().providers.map((provider) => provider.id)).toEqual(['ollama']);

    useAiSettingsStore.getState().removeProvider('ollama');
    expect(useAiSettingsStore.getState().providers).toHaveLength(1);
  });
});

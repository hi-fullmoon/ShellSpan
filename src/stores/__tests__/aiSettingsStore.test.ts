import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETRY_POLICY } from '@/lib/ai/retry-policy';
import {
  flushAiSettingsPreferences,
  parseAiPreferences,
  useAiSettingsStore,
} from '../aiSettingsStore';

const tauri = vi.hoisted(() => ({
  invokeLoadPreferences: vi.fn().mockResolvedValue([]),
  invokeSavePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ipc/tauri', () => tauri);

const initialState = useAiSettingsStore.getState();

function preference(key: string, value: unknown): [string, string] {
  return [`ai.${key}`, JSON.stringify(value)];
}

describe('aiSettingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.invokeLoadPreferences.mockResolvedValue([]);
    tauri.invokeSavePreferences.mockResolvedValue(undefined);
    useAiSettingsStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('snapshots each request config without persisting legacy Provider state', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ initialized: true });
    const first = useAiSettingsStore.getState().providers[0].id;
    const second = useAiSettingsStore.getState().providers[1].id;
    useAiSettingsStore.getState().updateProvider(first, { retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 } });
    useAiSettingsStore.getState().updateProvider(second, { retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 8, maxServerDelayMs: 1000 } });
    const snapshot = useAiSettingsStore.getState().getProviderConfig(first);
    useAiSettingsStore.getState().updateProvider(first, { retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 4 } });
    expect(snapshot.retryPolicy?.maxAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    await flushAiSettingsPreferences();
    expect(useAiSettingsStore.getState().getProviderConfig(first).retryPolicy?.maxAttempts).toBe(4);
    expect(useAiSettingsStore.getState().getProviderConfig(second).retryPolicy).toEqual({ ...DEFAULT_RETRY_POLICY, maxAttempts: 8, maxServerDelayMs: 1000 });
    expect(tauri.invokeSavePreferences).not.toHaveBeenCalled();
  });

  it('keeps invalid stored policy visible and rejects it when building a request', () => {
    const provider = initialState.providers[0];
    const restored = parseAiPreferences([preference('providers', [{ ...provider, retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 999 } }])]);
    useAiSettingsStore.setState(restored);
    expect(() => useAiSettingsStore.getState().getProviderConfig(provider.id)).toThrow('Invalid AI retry policy');
    expect(() => useAiSettingsStore.getState().updateProvider(provider.id, { retryPolicy: { ...DEFAULT_RETRY_POLICY, jitterRatio: Infinity } })).toThrow();
    expect(parseAiPreferences([preference('providers', [provider])]).providers[0].retryPolicy).toBeUndefined();
  });

  it('preserves malformed persisted capability choices and rejects them before request creation', () => {
    const provider = initialState.providers[0];
    for (const invalid of [{ profile: 'unknown-preset' }]) {
      const restored = parseAiPreferences([preference('providers', [{ ...provider, ...invalid }])]);
      useAiSettingsStore.setState(restored);
      expect(useAiSettingsStore.getState().providers[0]).toMatchObject(invalid);
      expect(() => useAiSettingsStore.getState().getProviderConfig(provider.id)).toThrow(/UNKNOWN_PROFILE|UNSUPPORTED_REASONING_EFFORT/);
    }
    const custom = parseAiPreferences([preference('providers', [{ ...provider, reasoningEffort: 'ultra' }])]);
    useAiSettingsStore.setState(custom);
    expect(useAiSettingsStore.getState().getProviderConfig(provider.id).reasoningEffort).toBe('ultra');
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
      },
      {
        id: 'local',
        name: 'Local Ollama',
        preset: 'ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3',
        requiresApiKey: false,
      },
    ];
    const preferences = parseAiPreferences([
      preference('providers', providers),
      preference('defaultProviderId', 'missing'),
    ]);

    expect(preferences.providers).toHaveLength(2);
    expect(preferences.defaultProviderId).toBe('deepseek-primary');
  });

  it.each([false, true])('ignores the removed Agent enable preference (%s) in legacy and current settings', async (enabled) => {
    const legacyEntries = [preference('agentEnabled', enabled)];
    const currentEntries = [preference('providers', initialState.providers), ...legacyEntries];
    expect(parseAiPreferences([])).not.toHaveProperty('agentEnabled');
    expect(parseAiPreferences(legacyEntries)).toEqual(parseAiPreferences([]));
    expect(parseAiPreferences(currentEntries))
      .toEqual(parseAiPreferences([preference('providers', initialState.providers)]));

    tauri.invokeLoadPreferences.mockResolvedValue(currentEntries);
    await useAiSettingsStore.getState().hydrateFromDb();

    expect(useAiSettingsStore.getState()).not.toHaveProperty('agentEnabled');
    useAiSettingsStore.getState().setContextLines(500);
    await flushAiSettingsPreferences();
    const entries = tauri.invokeSavePreferences.mock.lastCall![0] as [string, string][];
    expect(entries.map(([key]) => key))
      .toEqual(['ai.contextLines']);
  });

  it('adds a preset and exposes it as the selected request config', () => {
    const id = useAiSettingsStore.getState().addProvider('deepseek');
    useAiSettingsStore.getState().setDefaultProvider(id);

    expect(useAiSettingsStore.getState().getProviderConfig()).toEqual({
      id,
      profile: 'deepseek',
      kind: 'openAiCompatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      requiresApiKey: true,
    });
  });

  it('adds Anthropic as a first-class Messages provider without storing a key', () => {
    const id = useAiSettingsStore.getState().addProvider('anthropic');
    expect(useAiSettingsStore.getState().getProviderConfig(id)).toEqual({
      id,
      profile: 'anthropic',
      kind: 'anthropicMessages',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
      requiresApiKey: true,
    });
    expect(useAiSettingsStore.getState().providers.find((provider) => provider.id === id))
      .not.toHaveProperty('apiKey');
  });

  it('keeps API version paths out of provider preset URLs', () => {
    const minimaxId = useAiSettingsStore.getState().addProvider('minimax');
    const kimiId = useAiSettingsStore.getState().addProvider('kimi');

    expect(useAiSettingsStore.getState().getProviderConfig(minimaxId).baseUrl)
      .toBe('https://api.minimaxi.com');
    expect(useAiSettingsStore.getState().getProviderConfig(kimiId)).toEqual(expect.objectContaining({
      baseUrl: 'https://api.kimi.com/coding',
      model: 'k3',
    }));
    expect(useAiSettingsStore.getState().getProviderConfig(kimiId))
      .not.toHaveProperty('reasoningEffort');
  });

  it('preserves thinking controls for explicit backend validation after a model change', () => {
    const kimiId = useAiSettingsStore.getState().addProvider('kimi');
    useAiSettingsStore.getState().updateProvider(kimiId, { reasoningEffort: 'max' });

    expect(useAiSettingsStore.getState().getProviderConfig(kimiId))
      .toEqual(expect.objectContaining({ reasoningEffort: 'max' }));

    useAiSettingsStore.getState().updateProvider(kimiId, { model: 'kimi-for-coding' });
    expect(useAiSettingsStore.getState().getProviderConfig(kimiId))
      .toHaveProperty('reasoningEffort', 'max');
    expect(useAiSettingsStore.getState().providers.find((provider) => provider.id === kimiId))
      .toHaveProperty('reasoningEffort', 'max');

    const deepseekId = useAiSettingsStore.getState().addProvider('deepseek');
    useAiSettingsStore.getState().updateProvider(deepseekId, { reasoningEffort: 'off' });
    expect(useAiSettingsStore.getState().getProviderConfig(deepseekId))
      .toEqual(expect.objectContaining({ reasoningEffort: 'off' }));

    useAiSettingsStore.getState().updateProvider(deepseekId, { reasoningEffort: undefined });
    expect(useAiSettingsStore.getState().providers.find((provider) => provider.id === deepseekId))
      .not.toHaveProperty('reasoningEffort');

    const minimaxId = useAiSettingsStore.getState().addProvider('minimax');
    useAiSettingsStore.getState().updateProvider(minimaxId, {
      model: 'MiniMax-M3',
      reasoningEffort: 'on',
    });
    expect(useAiSettingsStore.getState().getProviderConfig(minimaxId))
      .toEqual(expect.objectContaining({ reasoningEffort: 'on' }));

    useAiSettingsStore.getState().updateProvider(minimaxId, { model: 'MiniMax-M2.7' });
    expect(useAiSettingsStore.getState().getProviderConfig(minimaxId))
      .toHaveProperty('reasoningEffort', 'on');
  });

  it('drops legacy inline API keys from provider state and request configs', () => {
    const provider = {
      id: 'minimax',
      name: 'MiniMax',
      preset: 'minimax',
      kind: 'openAiCompatible',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      requiresApiKey: true,
      apiKey: '  database-key  ',
    };
    const preferences = parseAiPreferences([
      preference('providers', [provider]),
      preference('defaultProviderId', provider.id),
    ]);
    useAiSettingsStore.setState({ ...preferences, initialized: false });

    expect(preferences.providers[0]).not.toHaveProperty('apiKey');
    expect(useAiSettingsStore.getState().getProviderConfig()).toEqual({
      id: 'minimax',
      profile: 'minimax',
      kind: 'openAiCompatible',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      requiresApiKey: true,
    });
  });

  it('never serializes a legacy runtime API key back to preferences', async () => {
    vi.useFakeTimers();
    const provider = {
      ...initialState.providers[1],
      apiKey: 'must-not-be-persisted',
    } as typeof initialState.providers[number];

    useAiSettingsStore.setState({
      providers: [initialState.providers[0], provider],
      initialized: true,
    });
    await vi.advanceTimersByTimeAsync(400);

    expect(tauri.invokeSavePreferences).not.toHaveBeenCalled();
  });

  it('moves the default when deleting a provider and always retains one provider', () => {
    useAiSettingsStore.getState().setDefaultProvider('openai');
    useAiSettingsStore.getState().removeProvider('openai');

    expect(useAiSettingsStore.getState().defaultProviderId).toBe('ollama');
    expect(useAiSettingsStore.getState().providers.map((provider) => provider.id)).toEqual(['ollama']);

    useAiSettingsStore.getState().removeProvider('ollama');
    expect(useAiSettingsStore.getState().providers).toHaveLength(1);
  });

  it('reports pending and saved states around the debounced context-line write', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);

    useAiSettingsStore.getState().setContextLines(321);

    expect(useAiSettingsStore.getState().persistenceStatus).toBe('pending');
    expect(tauri.invokeSavePreferences).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(tauri.invokeSavePreferences).toHaveBeenCalledOnce();
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
  });

  it('flushes pending context-line changes immediately before application exit', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);
    useAiSettingsStore.getState().setContextLines(444);

    await flushAiSettingsPreferences();

    expect(tauri.invokeSavePreferences).toHaveBeenCalledWith(expect.arrayContaining([
      ['ai.contextLines', '444'],
    ]));
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a failed write and retains the latest preferences for retry', async () => {
    vi.useFakeTimers();
    tauri.invokeSavePreferences.mockRejectedValueOnce(new Error('database unavailable'));
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);
    useAiSettingsStore.getState().setContextLines(555);

    await vi.advanceTimersByTimeAsync(400);

    expect(useAiSettingsStore.getState().persistenceStatus).toBe('error');
    tauri.invokeSavePreferences.mockResolvedValueOnce(undefined);

    await flushAiSettingsPreferences();

    expect(tauri.invokeSavePreferences).toHaveBeenCalledTimes(2);
    expect(tauri.invokeSavePreferences).toHaveBeenLastCalledWith(expect.arrayContaining([
      ['ai.contextLines', '555'],
    ]));
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
  });
});

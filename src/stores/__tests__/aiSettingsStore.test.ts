import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushAiSettingsPreferences,
  parseAiPreferences,
  useAiSettingsStore,
} from '../aiSettingsStore';

const tauri = vi.hoisted(() => ({
  invokeLoadPreferences: vi.fn().mockResolvedValue([]),
  invokeSavePreferences: vi.fn().mockResolvedValue(undefined),
  invokeSetAgentEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/tauri', () => tauri);

const initialState = useAiSettingsStore.getState();

function preference(key: string, value: unknown): [string, string] {
  return [`ai.${key}`, JSON.stringify(value)];
}

describe('aiSettingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.invokeLoadPreferences.mockResolvedValue([]);
    tauri.invokeSavePreferences.mockResolvedValue(undefined);
    tauri.invokeSetAgentEnabled.mockResolvedValue(true);
    useAiSettingsStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('defaults Stable installs on and preserves an explicit user opt-out', async () => {
    expect(parseAiPreferences([]).agentEnabled).toBe(true);
    expect(parseAiPreferences([preference('agentEnabled', false)]).agentEnabled).toBe(false);

    tauri.invokeLoadPreferences.mockResolvedValue([preference('agentEnabled', false)]);
    await useAiSettingsStore.getState().hydrateFromDb();

    expect(useAiSettingsStore.getState().agentEnabled).toBe(false);
    expect(tauri.invokeSetAgentEnabled).toHaveBeenCalledWith(false);
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
    });
  });

  it('keeps API version paths out of provider preset URLs', () => {
    const minimaxId = useAiSettingsStore.getState().addProvider('minimax');
    const kimiId = useAiSettingsStore.getState().addProvider('kimi');

    expect(useAiSettingsStore.getState().getProviderConfig(minimaxId).baseUrl)
      .toBe('https://api.minimaxi.com');
    expect(useAiSettingsStore.getState().getProviderConfig(kimiId)).toEqual(expect.objectContaining({
      baseUrl: 'https://api.kimi.com/coding',
      model: 'k3',
      reasoningEffort: 'high',
    }));
  });

  it('persists Kimi K3 thinking effort and only sends it to K3 models', () => {
    const kimiId = useAiSettingsStore.getState().addProvider('kimi');
    useAiSettingsStore.getState().updateProvider(kimiId, { reasoningEffort: 'max' });

    expect(useAiSettingsStore.getState().getProviderConfig(kimiId))
      .toEqual(expect.objectContaining({ reasoningEffort: 'max' }));

    useAiSettingsStore.getState().updateProvider(kimiId, { model: 'kimi-for-coding' });
    expect(useAiSettingsStore.getState().getProviderConfig(kimiId))
      .not.toHaveProperty('reasoningEffort');
    expect(useAiSettingsStore.getState().providers.find((provider) => provider.id === kimiId))
      .toHaveProperty('reasoningEffort', 'max');
  });

  it('keeps inline API keys in provider preferences and trims them for requests', () => {
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

    expect(preferences.providers[0]).toHaveProperty('apiKey', '  database-key  ');
    expect(useAiSettingsStore.getState().getProviderConfig()).toEqual({
      id: 'minimax',
      kind: 'openAiCompatible',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      requiresApiKey: true,
      apiKey: 'database-key',
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

  it('reports pending and saved states around the debounced database write', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);

    useAiSettingsStore.getState().updateProvider('openai', { apiKey: 'database-key' });

    expect(useAiSettingsStore.getState().persistenceStatus).toBe('pending');
    expect(tauri.invokeSavePreferences).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(tauri.invokeSavePreferences).toHaveBeenCalledOnce();
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
  });

  it('flushes a pending API key immediately before application exit', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);
    useAiSettingsStore.getState().updateProvider('openai', { apiKey: 'exit-key' });

    await flushAiSettingsPreferences();

    expect(tauri.invokeSavePreferences).toHaveBeenCalledWith(expect.arrayContaining([
      ['ai.providers', expect.stringContaining('exit-key')],
    ]));
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a failed write and retains the latest preferences for retry', async () => {
    vi.useFakeTimers();
    tauri.invokeSavePreferences.mockRejectedValueOnce(new Error('database unavailable'));
    useAiSettingsStore.setState({ ...initialState, initialized: true }, true);
    useAiSettingsStore.getState().updateProvider('openai', { apiKey: 'retry-key' });

    await vi.advanceTimersByTimeAsync(400);

    expect(useAiSettingsStore.getState().persistenceStatus).toBe('error');
    tauri.invokeSavePreferences.mockResolvedValueOnce(undefined);

    await flushAiSettingsPreferences();

    expect(tauri.invokeSavePreferences).toHaveBeenCalledTimes(2);
    expect(tauri.invokeSavePreferences).toHaveBeenLastCalledWith(expect.arrayContaining([
      ['ai.providers', expect.stringContaining('retry-key')],
    ]));
    expect(useAiSettingsStore.getState().persistenceStatus).toBe('saved');
  });
});

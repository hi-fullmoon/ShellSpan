import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('ignores per-provider retry settings and leaves recovery to the runtime default', async () => {
    vi.useFakeTimers();
    useAiSettingsStore.setState({ initialized: true });
    const first = useAiSettingsStore.getState().providers[0].id;
    const second = useAiSettingsStore.getState().providers[1].id;
    const customRetry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, maxServerDelayMs: 0, jitterRatio: 0 };
    useAiSettingsStore.getState().updateProvider(first, { retryPolicy: customRetry });
    useAiSettingsStore.getState().updateProvider(second, { retryPolicy: customRetry });
    const snapshot = useAiSettingsStore.getState().getProviderConfig(first);
    expect(snapshot).not.toHaveProperty('retryPolicy');
    await vi.advanceTimersByTimeAsync(400);
    await flushAiSettingsPreferences();
    expect(useAiSettingsStore.getState().providers[0]).not.toHaveProperty('retryPolicy');
    expect(useAiSettingsStore.getState().providers[1]).not.toHaveProperty('retryPolicy');
    expect(tauri.invokeSavePreferences).not.toHaveBeenCalled();
  });

  it('loads only the current context preference', () => {
    const preferences = parseAiPreferences([
      preference('contextLines', 500),
      preference('providers', [{ id: 'ignored-old-provider' }]),
    ]);
    expect(preferences.contextLines).toBe(500);
    expect(preferences.providers).toEqual(initialState.providers);
    expect(preferences.defaultProviderId).toBe(initialState.defaultProviderId);
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

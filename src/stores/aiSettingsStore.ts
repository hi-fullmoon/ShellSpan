import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  AiProviderConfig,
  AiProviderKind,
  AiProviderPreset,
  AiProviderProfile,
} from '@/types/ai';
import {
  invokeLoadPreferences,
  invokeSavePreferences,
  invokeSetAgentEnabled,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { generateId } from '@/lib/utils';
import {
  effectiveReasoningEffort,
  isAiReasoningOption,
} from '@/lib/ai-reasoning';

const logger = createLogger('aiSettingsStore');

export interface AiProviderPresetDefinition {
  preset: AiProviderPreset;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPresetDefinition[] = [
  {
    preset: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3',
    requiresApiKey: false,
  },
  {
    preset: 'openai',
    name: 'OpenAI',
    kind: 'openAi',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-5.4-mini',
    requiresApiKey: true,
  },
  {
    preset: 'deepseek',
    name: 'DeepSeek',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    requiresApiKey: true,
  },
  {
    preset: 'minimax',
    name: 'MiniMax',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    requiresApiKey: true,
  },
  {
    preset: 'kimi',
    name: 'Kimi Code',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.kimi.com/coding',
    model: 'k3',
    requiresApiKey: true,
  },
  {
    preset: 'custom',
    name: 'Custom Provider',
    kind: 'openAiCompatible',
    baseUrl: '',
    model: '',
    requiresApiKey: true,
  },
] as const;

interface AiPreferences {
  providers: AiProviderProfile[];
  defaultProviderId: string;
  contextLines: number;
  agentEnabled: boolean;
}

interface AiSettingsState extends AiPreferences {
  initialized: boolean;
  persistenceStatus: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  hydrateFromDb: () => Promise<void>;
  addProvider: (
    preset: AiProviderPreset,
    changes?: Partial<Omit<AiProviderProfile, 'id' | 'preset'>>,
  ) => string;
  updateProvider: (id: string, changes: Partial<Omit<AiProviderProfile, 'id'>>) => void;
  removeProvider: (id: string) => void;
  setDefaultProvider: (id: string) => void;
  setContextLines: (lines: number) => void;
  setAgentEnabled: (enabled: boolean) => void;
  getProviderConfig: (id?: string) => AiProviderConfig;
}

function presetDefinition(preset: AiProviderPreset): AiProviderPresetDefinition {
  return AI_PROVIDER_PRESETS.find((definition) => definition.preset === preset)
    ?? AI_PROVIDER_PRESETS[AI_PROVIDER_PRESETS.length - 1];
}

function createProviderProfile(
  preset: AiProviderPreset,
  existing: AiProviderProfile[],
  preferredId?: string,
): AiProviderProfile {
  const definition = presetDefinition(preset);
  const baseId = preferredId ?? definition.preset;
  const id = existing.some((provider) => provider.id === baseId)
    ? `${baseId}-${generateId()}`
    : baseId;
  return { id, ...definition };
}

const initialProviders = [
  createProviderProfile('ollama', []),
  createProviderProfile('openai', [], 'openai'),
];

const defaults: AiPreferences = {
  providers: initialProviders,
  defaultProviderId: 'ollama',
  contextLines: 200,
  agentEnabled: true,
};

const PREFERENCE_KEYS = ['providers', 'defaultProviderId', 'contextLines', 'agentEnabled'] as const;

function storageKey(key: keyof AiPreferences): string {
  return `ai.${key}`;
}

function isProviderKind(value: unknown): value is AiProviderKind {
  return value === 'ollama' || value === 'openAi' || value === 'openAiCompatible';
}

function isProviderPreset(value: unknown): value is AiProviderPreset {
  return ['ollama', 'openai', 'deepseek', 'minimax', 'kimi', 'custom'].includes(String(value));
}

function sanitizeProviders(value: unknown): AiProviderProfile[] {
  if (!Array.isArray(value)) return [];
  const providers: AiProviderProfile[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const provider = candidate as Record<string, unknown>;
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    const preset = isProviderPreset(provider.preset) ? provider.preset : 'custom';
    const name = typeof provider.name === 'string' && provider.name.trim()
      ? provider.name.trim()
      : presetDefinition(preset).name;
    if (
      !id
      || !/^[A-Za-z0-9._-]{1,80}$/.test(id)
      || providers.some((item) => item.id === id)
      || !isProviderKind(provider.kind)
    ) continue;
    providers.push({
      id,
      name,
      kind: provider.kind,
      preset,
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
      model: typeof provider.model === 'string' ? provider.model : '',
      ...(isAiReasoningOption(provider.reasoningEffort)
        ? { reasoningEffort: provider.reasoningEffort }
        : {}),
      requiresApiKey: typeof provider.requiresApiKey === 'boolean'
        ? provider.requiresApiKey
        : provider.kind !== 'ollama',
    });
  }
  return providers;
}

function parseRawEntries(entries: [string, string][]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!key.startsWith('ai.')) continue;
    try {
      parsed[key.slice(3)] = JSON.parse(value);
    } catch {
      parsed[key.slice(3)] = value;
    }
  }
  return parsed;
}

export function parseAiPreferences(entries: [string, string][]): AiPreferences {
  const parsed = parseRawEntries(entries);
  const storedProviders = sanitizeProviders(parsed.providers);
  if (storedProviders.length > 0) {
    const defaultProviderId = typeof parsed.defaultProviderId === 'string'
      && storedProviders.some((provider) => provider.id === parsed.defaultProviderId)
      ? parsed.defaultProviderId
      : storedProviders[0].id;
    return {
      providers: storedProviders,
      defaultProviderId,
      contextLines: typeof parsed.contextLines === 'number' ? parsed.contextLines : defaults.contextLines,
      agentEnabled: typeof parsed.agentEnabled === 'boolean'
        ? parsed.agentEnabled
        : defaults.agentEnabled,
    };
  }

  const ollama = {
    ...createProviderProfile('ollama', []),
    baseUrl: typeof parsed.ollamaBaseUrl === 'string'
      ? parsed.ollamaBaseUrl
      : presetDefinition('ollama').baseUrl,
    model: typeof parsed.ollamaModel === 'string'
      ? parsed.ollamaModel
      : presetDefinition('ollama').model,
  };
  const openai = {
    ...createProviderProfile('openai', [ollama], 'openai'),
    baseUrl: typeof parsed.openAiBaseUrl === 'string'
      ? parsed.openAiBaseUrl
      : presetDefinition('openai').baseUrl,
    model: typeof parsed.openAiModel === 'string'
      ? parsed.openAiModel
      : presetDefinition('openai').model,
  };
  return {
    providers: [ollama, openai],
    defaultProviderId: parsed.providerKind === 'openAi' ? openai.id : ollama.id,
    contextLines: typeof parsed.contextLines === 'number' ? parsed.contextLines : defaults.contextLines,
    agentEnabled: typeof parsed.agentEnabled === 'boolean'
      ? parsed.agentEnabled
      : defaults.agentEnabled,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: AiPreferences | undefined;
let saveInFlight: Promise<void> | null = null;

function preferenceEntries(preferences: AiPreferences): [string, string][] {
  return PREFERENCE_KEYS.map((key) => [
    storageKey(key),
    JSON.stringify(key === 'providers'
      ? preferences.providers.map((provider) => {
          const safeProvider = { ...provider } as AiProviderProfile & {
            apiKey?: unknown;
          };
          delete safeProvider.apiKey;
          return safeProvider;
        })
      : preferences[key]),
  ]);
}

async function savePendingPreferences(): Promise<void> {
  while (pendingPreferences) {
    const preferences = pendingPreferences;
    pendingPreferences = undefined;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    useAiSettingsStore.setState({ persistenceStatus: 'saving' });
    try {
      await invokeSavePreferences(preferenceEntries(preferences));
    } catch (error) {
      // A newer full snapshot supersedes the failed one. Otherwise retain the
      // failed snapshot so an explicit exit flush or the next edit can retry it.
      pendingPreferences ??= preferences;
      useAiSettingsStore.setState({ persistenceStatus: 'error' });
      logger.error('failed to save AI preferences', error);
      throw error;
    }
  }
  useAiSettingsStore.setState({ persistenceStatus: 'saved' });
}

export function flushAiSettingsPreferences(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!saveInFlight && pendingPreferences) {
    saveInFlight = savePendingPreferences().finally(() => {
      saveInFlight = null;
    });
  }
  if (!saveInFlight) return Promise.resolve();
  return saveInFlight.then(() => (
    pendingPreferences ? flushAiSettingsPreferences() : undefined
  ));
}

function schedulePreferencesSave(preferences: AiPreferences): void {
  pendingPreferences = preferences;
  useAiSettingsStore.setState({ persistenceStatus: 'pending' });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushAiSettingsPreferences().catch(() => undefined);
  }, 400);
}

async function synchronizeAgentRuntime(enabled: boolean): Promise<void> {
  try {
    await invokeSetAgentEnabled(enabled);
  } catch (error) {
    logger.error('failed to synchronize Agent runtime access', error);
  }
}

export const useAiSettingsStore = create<AiSettingsState>()(
  subscribeWithSelector((set, get) => ({
    ...defaults,
    initialized: false,
    persistenceStatus: 'idle',
    hydrateFromDb: async () => {
      try {
        const entries = await invokeLoadPreferences();
        const preferences = parseAiPreferences(entries);
        // Keep initialization false while applying the loaded snapshot so the
        // persistence subscriber never rewrites unchanged preferences during hydration.
        set(preferences);
        set({ initialized: true });
        await synchronizeAgentRuntime(preferences.agentEnabled);
      } catch (error) {
        logger.error('failed to load AI preferences', error);
        set({ initialized: true });
        await synchronizeAgentRuntime(defaults.agentEnabled);
      }
    },
    addProvider: (preset, changes) => {
      const provider = {
        ...createProviderProfile(preset, get().providers),
        ...changes,
      };
      set((state) => ({ providers: [...state.providers, provider] }));
      return provider.id;
    },
    updateProvider: (id, changes) => set((state) => ({
      providers: state.providers.map((provider) => {
        if (provider.id !== id) return provider;
        const updated = { ...provider, ...changes, id };
        if ('reasoningEffort' in changes && changes.reasoningEffort === undefined) {
          delete updated.reasoningEffort;
        }
        return updated;
      }),
    })),
    removeProvider: (id) => set((state) => {
      if (state.providers.length <= 1) return state;
      const providers = state.providers.filter((provider) => provider.id !== id);
      if (providers.length === state.providers.length) return state;
      return {
        providers,
        defaultProviderId: state.defaultProviderId === id
          ? providers[0].id
          : state.defaultProviderId,
      };
    }),
    setDefaultProvider: (defaultProviderId) => set((state) => (
      state.providers.some((provider) => provider.id === defaultProviderId)
        ? { defaultProviderId }
        : state
    )),
    setContextLines: (contextLines) => set({ contextLines }),
    setAgentEnabled: (agentEnabled) => set({ agentEnabled }),
    getProviderConfig: (id) => {
      const state = get();
      const provider = state.providers.find((item) => item.id === (id ?? state.defaultProviderId))
        ?? state.providers[0];
      if (!provider) throw new Error('No AI provider is configured');
      const reasoningEffort = effectiveReasoningEffort(provider);
      return {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl.trim(),
        model: provider.model.trim(),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        requiresApiKey: provider.requiresApiKey,
      };
    },
  })),
);

useAiSettingsStore.subscribe(
  (state): AiPreferences => ({
    providers: state.providers,
    defaultProviderId: state.defaultProviderId,
    contextLines: state.contextLines,
    agentEnabled: state.agentEnabled,
  }),
  (preferences) => {
    if (useAiSettingsStore.getState().initialized) schedulePreferencesSave(preferences);
  },
  { equalityFn: shallow },
);

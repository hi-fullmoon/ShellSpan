import { create } from 'zustand';
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
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { generateId } from '@/lib/utils';
import {
  isAiReasoningOption,
} from '@/lib/ai/ai-reasoning';

import { isProviderProfile, resolveProviderProfile } from '@/lib/ai/provider-contract';
import type { AgentPermissionMode } from '@/types/agent-approval';
import type { AgentExecutionSurface } from '@/types/agent-session';
import llmCatalog from '../../protocol/llm/catalog.json';

const logger = createLogger('aiSettingsStore');
const AGENT_SANDBOX_ENABLED_KEY = 'ai.agentSandboxEnabled';
const VIM_BRIDGE_AUTO_ATTACH_KEY = 'ai.vimBridgeAutoAttach';

function catalogDefaultModel(
  profile: import('@/lib/ai/provider-contract').ProviderProfileId,
): string {
  const preset = llmCatalog.presets[profile] as { defaultModel?: string } | undefined;
  return preset?.defaultModel ?? '';
}

export interface AiProviderPresetDefinition {
  preset: AiProviderPreset;
  profile: import('@/lib/ai/provider-contract').ProviderProfileId;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPresetDefinition[] = [
  {
    preset: 'ollama',
    profile: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: catalogDefaultModel('ollama'),
    requiresApiKey: false,
  },
  {
    preset: 'openai',
    profile: 'openai',
    name: 'OpenAI',
    kind: 'openAi',
    baseUrl: 'https://api.openai.com',
    model: catalogDefaultModel('openai'),
    requiresApiKey: true,
  },
  {
    preset: 'anthropic',
    profile: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropicMessages',
    baseUrl: 'https://api.anthropic.com',
    model: catalogDefaultModel('anthropic'),
    requiresApiKey: true,
  },
  {
    preset: 'deepseek',
    profile: 'deepseek',
    name: 'DeepSeek',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.deepseek.com',
    model: catalogDefaultModel('deepseek'),
    requiresApiKey: true,
  },
  {
    preset: 'minimax',
    profile: 'minimax',
    name: 'MiniMax',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.minimaxi.com',
    model: catalogDefaultModel('minimax'),
    requiresApiKey: true,
  },
  {
    preset: 'kimi',
    profile: 'kimi',
    name: 'Kimi Code',
    kind: 'openAiCompatible',
    baseUrl: 'https://api.kimi.com/coding',
    model: catalogDefaultModel('kimi'),
    requiresApiKey: true,
  },
  { preset: 'qwen', profile: 'qwen', name: 'Qwen', kind: 'openAiCompatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: catalogDefaultModel('qwen'), requiresApiKey: true },
  { preset: 'glm', profile: 'glm', name: 'GLM', kind: 'openAiCompatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: catalogDefaultModel('glm'), requiresApiKey: true },
  {
    preset: 'openrouter',
    profile: 'openrouter',
    name: 'OpenRouter',
    kind: 'openAiCompatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: catalogDefaultModel('openrouter'),
    requiresApiKey: true,
  },
  {
    preset: 'custom',
    profile: 'generic',
    name: 'Custom Provider',
    kind: 'openAiCompatible',
    baseUrl: '',
    model: catalogDefaultModel('generic'),
    requiresApiKey: true,
  },
] as const;

interface AiPreferences {
  providers: AiProviderProfile[];
  defaultProviderId: string;
  contextLines: number;
  agentPermissionMode: AgentPermissionMode;
  agentExecutionSurface: AgentExecutionSurface;
}

interface AiSettingsState extends AiPreferences {
  initialized: boolean;
  agentSandboxEnabled: boolean;
  agentSandboxSaving: boolean;
  vimBridgeAutoAttach: boolean;
  vimBridgeAutoAttachSaving: boolean;
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
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setAgentExecutionSurface: (surface: AgentExecutionSurface) => void;
  setAgentSandboxEnabled: (enabled: boolean) => Promise<void>;
  setVimBridgeAutoAttach: (enabled: boolean) => Promise<void>;
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
  agentPermissionMode: 'autoApproveReadOnly',
  agentExecutionSurface: 'direct',
};

// RouteStore owns provider connections and model selection. This store persists
// only independent composer and terminal-context preferences.
const PREFERENCE_KEYS = ['contextLines', 'agentPermissionMode', 'agentExecutionSurface'] as const;

function storageKey(key: keyof AiPreferences): string {
  return `ai.${key}`;
}

export function parseAiPreferences(entries: [string, string][]): AiPreferences {
  const read = (key: keyof AiPreferences): unknown => {
    const raw = entries.find(([entryKey]) => entryKey === storageKey(key))?.[1];
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  let contextLines = defaults.contextLines;
  const contextValue = read('contextLines');
  if (typeof contextValue === 'number') contextLines = contextValue;
  const permissionValue = read('agentPermissionMode');
  const surfaceValue = read('agentExecutionSurface');
  return {
    ...defaults,
    contextLines,
    agentPermissionMode: permissionValue === 'requestApproval' || permissionValue === 'fullAccess'
      ? permissionValue : defaults.agentPermissionMode,
    agentExecutionSurface: surfaceValue === 'boundTerminal' ? surfaceValue : defaults.agentExecutionSurface,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: AiPreferences | undefined;
let saveInFlight: Promise<void> | null = null;

function preferenceEntries(preferences: AiPreferences): [string, string][] {
  return PREFERENCE_KEYS.map((key) => [storageKey(key), JSON.stringify(preferences[key])]);
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

export const useAiSettingsStore = create<AiSettingsState>()(
  subscribeWithSelector((set, get) => ({
    ...defaults,
    initialized: false,
    agentSandboxEnabled: false,
    agentSandboxSaving: false,
    vimBridgeAutoAttach: false,
    vimBridgeAutoAttachSaving: false,
    persistenceStatus: 'idle',
    hydrateFromDb: async () => {
      try {
        const entries = await invokeLoadPreferences();
        const preferences = parseAiPreferences(entries);
        // Keep initialization false while applying the loaded snapshot so the
        // persistence subscriber never rewrites unchanged preferences during hydration.
        set({
          ...preferences,
          agentSandboxEnabled: entries.some(([key, value]) => key === AGENT_SANDBOX_ENABLED_KEY && value === 'true'),
          vimBridgeAutoAttach: entries.some(([key, value]) => key === VIM_BRIDGE_AUTO_ATTACH_KEY && value === 'true'),
        });
        set({ initialized: true });
      } catch (error) {
        logger.error('failed to load AI preferences', error);
        set({ initialized: true });
      }
    },
    addProvider: (preset, changes) => {
      const safeChanges = { ...changes };
      delete safeChanges.retryPolicy;
      const provider = {
        ...createProviderProfile(preset, get().providers),
        ...safeChanges,
      };
      set((state) => ({ providers: [...state.providers, provider] }));
      return provider.id;
    },
    updateProvider: (id, changes) => set((state) => ({
      providers: state.providers.map((provider) => {
        if (provider.id !== id) return provider;
        const safeChanges = { ...changes };
        delete safeChanges.retryPolicy;
        const updated = { ...provider, ...safeChanges, id };
        delete updated.retryPolicy;
        if (!('modelDefinition' in safeChanges) && (['model', 'kind', 'profile', 'baseUrl'] as const)
          .some(key => key in safeChanges && safeChanges[key] !== provider[key])) delete updated.modelDefinition;
        if ('reasoningEffort' in safeChanges && safeChanges.reasoningEffort === undefined) {
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
    setAgentPermissionMode: (agentPermissionMode) => set({ agentPermissionMode }),
    setAgentExecutionSurface: (agentExecutionSurface) => set({ agentExecutionSurface }),
    setAgentSandboxEnabled: async (agentSandboxEnabled) => {
      if (get().agentSandboxSaving) return;
      set({ agentSandboxSaving: true });
      try {
        await invokeSavePreferences([[AGENT_SANDBOX_ENABLED_KEY, String(agentSandboxEnabled)]]);
        set({ agentSandboxEnabled });
      } finally {
        set({ agentSandboxSaving: false });
      }
    },
    setVimBridgeAutoAttach: async (vimBridgeAutoAttach) => {
      if (get().vimBridgeAutoAttachSaving) return;
      set({ vimBridgeAutoAttachSaving: true });
      try {
        await invokeSavePreferences([[VIM_BRIDGE_AUTO_ATTACH_KEY, String(vimBridgeAutoAttach)]]);
        set({ vimBridgeAutoAttach });
      } finally {
        set({ vimBridgeAutoAttachSaving: false });
      }
    },
    getProviderConfig: (id) => {
      const state = get();
      const provider = state.providers.find((item) => item.id === (id ?? state.defaultProviderId))
        ?? state.providers[0];
      if (!provider) throw new Error('No AI provider is configured');
      if (!isProviderProfile(provider.profile)) throw new Error('UNKNOWN_PROFILE');
      if (provider.reasoningEffort !== undefined && !isAiReasoningOption(provider.reasoningEffort)) throw new Error('UNSUPPORTED_REASONING_EFFORT');
      const reasoningEffort = provider.reasoningEffort;
      const config: AiProviderConfig = {
        modelDefinition: provider.modelDefinition,
        id: provider.id,
        kind: provider.kind,
        profile: resolveProviderProfile(provider),
        baseUrl: provider.baseUrl.trim(),
        model: provider.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        requiresApiKey: provider.requiresApiKey,
      };
      return config;
    },
  })),
);

useAiSettingsStore.subscribe(
  (state) => `${state.contextLines}:${state.agentPermissionMode}:${state.agentExecutionSurface}`,
  () => {
    const state = useAiSettingsStore.getState();
    if (state.initialized) schedulePreferencesSave({
      providers: state.providers,
      defaultProviderId: state.defaultProviderId,
      contextLines: state.contextLines,
      agentPermissionMode: state.agentPermissionMode,
      agentExecutionSurface: state.agentExecutionSurface,
    });
  },
);

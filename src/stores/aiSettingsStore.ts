import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { subscribeWithSelector } from 'zustand/middleware';
import type { AiProviderConfig, AiProviderKind } from '@/types/ai';
import { invokeLoadPreferences, invokeSavePreferences } from '@/lib/tauri';
import { createLogger } from '@/lib/logger';

const logger = createLogger('aiSettingsStore');

interface AiPreferences {
  providerKind: AiProviderKind;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openAiBaseUrl: string;
  openAiModel: string;
  contextLines: number;
}

interface AiSettingsState extends AiPreferences {
  initialized: boolean;
  hydrateFromDb: () => Promise<void>;
  setProviderKind: (kind: AiProviderKind) => void;
  setBaseUrl: (url: string) => void;
  setModel: (model: string) => void;
  setContextLines: (lines: number) => void;
  getProviderConfig: () => AiProviderConfig;
}

const defaults: AiPreferences = {
  providerKind: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3',
  openAiBaseUrl: 'https://api.openai.com/v1',
  openAiModel: 'gpt-5.4-mini',
  contextLines: 200,
};

const PREFERENCE_KEYS = [
  'providerKind',
  'ollamaBaseUrl',
  'ollamaModel',
  'openAiBaseUrl',
  'openAiModel',
  'contextLines',
] as const;

function storageKey(key: keyof AiPreferences): string {
  return `ai.${key}`;
}

function parseStored(entries: [string, string][]): Partial<AiPreferences> {
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!key.startsWith('ai.')) continue;
    try {
      parsed[key.slice(3)] = JSON.parse(value);
    } catch {
      parsed[key.slice(3)] = value;
    }
  }
  return {
    providerKind: parsed.providerKind === 'openAi' ? 'openAi' : defaults.providerKind,
    ollamaBaseUrl: typeof parsed.ollamaBaseUrl === 'string' ? parsed.ollamaBaseUrl : defaults.ollamaBaseUrl,
    ollamaModel: typeof parsed.ollamaModel === 'string' ? parsed.ollamaModel : defaults.ollamaModel,
    openAiBaseUrl: typeof parsed.openAiBaseUrl === 'string' ? parsed.openAiBaseUrl : defaults.openAiBaseUrl,
    openAiModel: typeof parsed.openAiModel === 'string' ? parsed.openAiModel : defaults.openAiModel,
    contextLines: typeof parsed.contextLines === 'number' ? parsed.contextLines : defaults.contextLines,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function savePreferences(preferences: AiPreferences): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries: [string, string][] = PREFERENCE_KEYS.map((key) => [
      storageKey(key),
      JSON.stringify(preferences[key]),
    ]);
    invokeSavePreferences(entries).catch((error) => {
      logger.error('failed to save AI preferences', error);
    });
  }, 400);
}

export const useAiSettingsStore = create<AiSettingsState>()(
  subscribeWithSelector((set, get) => ({
    ...defaults,
    initialized: false,
    hydrateFromDb: async () => {
      try {
        const entries = await invokeLoadPreferences();
        set({ ...parseStored(entries), initialized: true });
      } catch (error) {
        logger.error('failed to load AI preferences', error);
        set({ initialized: true });
      }
    },
    setProviderKind: (providerKind) => set({ providerKind }),
    setBaseUrl: (baseUrl) => {
      if (get().providerKind === 'ollama') set({ ollamaBaseUrl: baseUrl });
      else set({ openAiBaseUrl: baseUrl });
    },
    setModel: (model) => {
      if (get().providerKind === 'ollama') set({ ollamaModel: model });
      else set({ openAiModel: model });
    },
    setContextLines: (contextLines) => set({ contextLines }),
    getProviderConfig: () => {
      const state = get();
      if (state.providerKind === 'ollama') {
        return {
          id: 'ollama',
          kind: 'ollama',
          baseUrl: state.ollamaBaseUrl.trim(),
          model: state.ollamaModel.trim(),
        };
      }
      return {
        id: 'openai',
        kind: 'openAi',
        baseUrl: state.openAiBaseUrl.trim(),
        model: state.openAiModel.trim(),
      };
    },
  })),
);

useAiSettingsStore.subscribe(
  (state): AiPreferences => ({
    providerKind: state.providerKind,
    ollamaBaseUrl: state.ollamaBaseUrl,
    ollamaModel: state.ollamaModel,
    openAiBaseUrl: state.openAiBaseUrl,
    openAiModel: state.openAiModel,
    contextLines: state.contextLines,
  }),
  (preferences) => {
    if (useAiSettingsStore.getState().initialized) savePreferences(preferences);
  },
  { equalityFn: shallow },
);

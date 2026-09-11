import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  ServerIcon,
  Settings2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_RETRY_POLICY } from '@/lib/ai/retry-policy';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Dialog } from '@/components/ui/dialog';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import {
  invokeGetAiRouteApiKey,
  invokeListAiModels,
  isTauriRuntime,
} from '@/lib/ipc/tauri';
import type { LocaleKey } from '@/locales';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderPresetDefinition,
  useAiSettingsStore,
} from '@/stores/aiSettingsStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import type {
  AiProviderConnectionConfig,
  AiProviderKind,
  AiProviderPreset,
  AiProviderProfile,
} from '@/types/ai';
import {
  AnthropicBrandIcon,
  DeepSeekBrandIcon,
  GlmBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
  OpenRouterBrandIcon,
  QwenBrandIcon,
} from './provider-brand-icons';

import { PROVIDER_PROFILE_IDS, resolveProviderProfile, useResolvedModel, profileProtocol, type DiscoveredModel, type ModelDefinition, type ProviderProfileId } from '@/lib/ai/provider-contract';
import {
  ProviderModelCatalogEditor,
  type ProviderModelDraft,
  validateProviderModels,
} from './provider-model-catalog-editor';

type ProviderDraft = Omit<AiProviderProfile, 'id'> & { apiKey?: string };
type ModelCatalogMode = 'inherited' | 'overrides' | 'explicit';

interface ProviderSetupDialogProps {
  open: boolean;
  provider?: AiProviderProfile;
  onOpenChange: (open: boolean) => void;
  onSaved: (providerId: string) => void;
  onDelete?: () => void;
}

type Feedback = {
  kind: 'error' | 'success';
  message: string;
  labelKey?: LocaleKey;
};

const PRESET_OPTIONS = [...AI_PROVIDER_PRESETS];

const PRESET_ICONS: Record<AiProviderPreset, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  ollama: OllamaBrandIcon,
  openai: OpenAiBrandIcon,
  anthropic: AnthropicBrandIcon,
  deepseek: DeepSeekBrandIcon,
  minimax: MiniMaxBrandIcon,
  kimi: KimiBrandIcon,
  qwen: QwenBrandIcon,
  glm: GlmBrandIcon,
  openrouter: OpenRouterBrandIcon,
  custom: ServerIcon,
};

const PROFILE_ICONS: Record<
  (typeof PROVIDER_PROFILE_IDS)[number],
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  openai: OpenAiBrandIcon,
  anthropic: AnthropicBrandIcon,
  ollama: OllamaBrandIcon,
  deepseek: DeepSeekBrandIcon,
  minimax: MiniMaxBrandIcon,
  qwen: QwenBrandIcon,
  glm: GlmBrandIcon,
  kimi: KimiBrandIcon,
  openrouter: OpenRouterBrandIcon,
  generic: ServerIcon,
};

const PROTOCOL_LABEL_KEYS: Record<AiProviderKind, LocaleKey> = {
  ollama: 'settings.ai.protocol.ollama',
  openAi: 'settings.ai.protocol.openAi',
  openAiCompatible: 'settings.ai.protocol.openAiCompatible',
  anthropicMessages: 'settings.ai.protocol.anthropicMessages',
};

const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/models',
  '/api/chat',
  '/api/tags',
  '/api/show',
  '/messages',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SYSTEM_INPUT_CLASS = 'bg-transparent';
const SYSTEM_INPUT_GROUP_CLASS =
  'h-9 bg-transparent has-[[data-slot=input-group-control]:disabled]:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-ring dark:bg-transparent dark:has-[[data-slot=input-group-control]:disabled]:bg-transparent';

function parseProviderBaseUrl(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:') return url;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

export function buildProviderRequestEndpoint(
  baseUrl: string,
  kind: AiProviderKind,
): string | undefined {
  const url = parseProviderBaseUrl(baseUrl);
  if (!url) return undefined;
  let basePath = url.pathname.replace(/\/$/, '');
  let hadEndpoint = false;
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (basePath.endsWith(suffix)) {
      basePath = basePath.slice(0, -suffix.length);
      hadEndpoint = true;
      break;
    }
  }
  if (kind === 'openAiCompatible' && url.hostname === 'api.deepseek.com') {
    if (basePath === '/v1') basePath = '';
  } else if (kind === 'openAiCompatible' && url.hostname === 'open.bigmodel.cn') {
    if (!basePath || basePath === '/v1') basePath = '/api/paas/v4';
  } else if (!hadEndpoint && kind !== 'ollama' && !basePath.endsWith('/v1')) {
    basePath = `${basePath.replace(/\/$/, '')}/v1`;
  }
  const requestPath = kind === 'ollama'
    ? 'api/chat'
    : kind === 'openAi'
      ? 'responses'
      : kind === 'anthropicMessages'
        ? 'messages'
        : 'chat/completions';
  url.pathname = `${basePath.replace(/\/$/, '')}/${requestPath}`;
  url.hash = '';
  return url.toString();
}

function draftConfig(
  draft: ProviderDraft,
  providerId?: string,
): AiProviderConnectionConfig {
  return {
    modelDefinition: draft.modelDefinition,
    id: providerId ?? 'provider-setup-draft',
    kind: draft.kind,
    profile: resolveProviderProfile(draft),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model,
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    requiresApiKey: draft.requiresApiKey,
    ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
}

function modelDefinitionOf(model: ModelDefinition): ModelDefinition {
  return {
    ...(model.displayName ? { displayName: model.displayName } : {}),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    toolCalling: model.toolCalling,
    textInput: model.textInput,
    imageInput: model.imageInput,
    reasoning: model.reasoning,
    compat: model.compat,
    ...(model.vision ? { vision: model.vision } : {}),
  };
}

function modelDefinitionForSave(
  model: ProviderModelDraft,
  definition: ModelDefinition,
): ModelDefinition {
  const displayName = model.displayName === undefined
    ? definition.displayName
    : model.displayName.trim() || undefined;
  const contextWindow = model.contextWindow ?? definition.contextWindow;
  const maxOutputTokens = model.maxOutputTokens
    ?? Math.min(definition.maxOutputTokens, contextWindow);
  return {
    ...definition,
    ...(displayName ? { displayName } : { displayName: undefined }),
    contextWindow,
    maxOutputTokens,
  };
}

function isUnknownModelFailure(reason: unknown): boolean {
  return (reason instanceof Error ? reason.message : String(reason)).includes('UNKNOWN_MODEL');
}

export const ProviderSetupDialog: React.FC<ProviderSetupDialogProps> = ({
  open,
  provider,
  onOpenChange,
  onSaved,
  onDelete,
}) => {
  const { t } = useI18n();
  const addProvider = useAiSettingsStore((state) => state.addProvider);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const [draft, setDraft] = useState<ProviderDraft>();
  const resolution = useResolvedModel(draft ? { ...draft, id: provider?.id ?? 'draft' } : undefined);
  const [providerModels, setProviderModels] = useState<ProviderModelDraft[]>([]);
  const [modelCatalogMode, setModelCatalogMode] = useState<ModelCatalogMode>('explicit');
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<string>();
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const routeSnapshot = useLlmRoutesStore((state) => state.snapshot);
  const hydrateRoutes = useLlmRoutesStore((state) => state.hydrate);
  const saveRoutes = useLlmRoutesStore((state) => state.save);
  const routeModels = useLlmRoutesStore((state) => state.modelsByRoute);
  const nativeRouteMode = isTauriRuntime();
  const modelRequestGeneration = useRef(0);
  const declarationRequestGeneration = useRef(0);
  const apiKeyRequestGeneration = useRef(0);
  useEffect(() => { if (open && !routeSnapshot) void hydrateRoutes(); }, [open, routeSnapshot, hydrateRoutes]);

  const invalidateModelRequest = (): void => {
    modelRequestGeneration.current += 1;
    declarationRequestGeneration.current += 1;
    setBusy(false);
    setModelBusy(false);
  };

  useEffect(() => {
    modelRequestGeneration.current += 1;
    apiKeyRequestGeneration.current += 1;
    if (!open) {
      setBusy(false);
      setApiKeyBusy(false);
      return;
    }
    setDraft(provider ? { ...provider } : undefined);
    const route = provider ? routeSnapshot?.routes.find((item) => item.id === provider.id) : undefined;
    const resolvedModels = provider ? routeModels[provider.id] ?? [] : [];
    setProviderModels(resolvedModels.length > 0
      ? resolvedModels.map((model) => ({
          id: model.modelId,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          definition: modelDefinitionOf(model),
        }))
      : provider?.model
        ? [{
            id: provider.model,
            ...(provider.modelDefinition?.displayName
              ? { displayName: provider.modelDefinition.displayName }
              : {}),
            ...(provider.modelDefinition ? { definition: provider.modelDefinition } : {}),
          }]
        : []);
    setModelCatalogMode(route?.models
      ? 'explicit'
      : route?.modelOverrides
        ? 'overrides'
        : route
          ? 'inherited'
          : 'explicit');
    setHasStoredApiKey(false);
    setShowApiKey(false);
    setRevealedApiKey(undefined);
    setApiKeyBusy(false);
    setAdvancedOpen(false);
    setBusy(false);
    setModelBusy(false);
    setModelDiscoveryError(undefined);
    setFeedback(undefined);
  }, [open, provider, routeSnapshot, routeModels]);

  useEffect(() => {
    if (!open || !provider?.requiresApiKey) return;
    setHasStoredApiKey(routeSnapshot?.routes.some(route => route.id === provider.id && route.auth.kind === 'keychain') ?? false);
  }, [open, provider?.id, provider?.requiresApiKey, routeSnapshot]);

  const selectedPreset = useMemo(
    () => PRESET_OPTIONS.find((preset) => preset.preset === draft?.preset) ?? null,
    [draft?.preset],
  );
  const requestEndpoint = draft
    ? buildProviderRequestEndpoint(draft.baseUrl, draft.kind)
    : undefined;
  const requestEndpointLabel = requestEndpoint
    ? t('settings.ai.requestEndpoint', { endpoint: requestEndpoint })
    : undefined;
  const profileCapabilityLabel = resolution.status === 'ready'
    ? `${t('settings.ai.profileLimits', {
      context: resolution.model.contextWindow,
      output: resolution.model.maxOutputTokens,
    })} · ${t(resolution.model.source === 'builtinCatalog'
      ? 'settings.ai.builtinSource'
      : 'settings.ai.userSource')}`
    : undefined;
  const canTest = Boolean(
    draft
    && requestEndpoint
    && (!draft.requiresApiKey || draft.apiKey?.trim() || (provider && hasStoredApiKey)),
  );
  const modelFailure = validateProviderModels(providerModels);
  const defaultModelExists = Boolean(
    draft?.model && providerModels.some((model) => model.id.trim() === draft.model),
  );
  const canSave = Boolean(
    canTest
    && draft?.name.trim()
    && modelFailure === undefined
    && defaultModelExists
    && (!nativeRouteMode || routeSnapshot),
  );

  const updateDraft = (changes: Partial<ProviderDraft>): void => {
    invalidateModelRequest();
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...changes };
      if (!('modelDefinition' in changes) && (['model', 'kind', 'profile', 'baseUrl'] as const)
        .some(key => key in changes && changes[key] !== current[key])) delete next.modelDefinition;
      return next;
    });
    setModelDiscoveryError(undefined);
    setFeedback(undefined);
  };

  const handleApiKeyChange = (apiKey: string): void => {
    apiKeyRequestGeneration.current += 1;
    setApiKeyBusy(false);
    setRevealedApiKey(undefined);
    updateDraft({ apiKey });
  };

  const handleApiKeyVisibility = async (): Promise<void> => {
    if (showApiKey) {
      setShowApiKey(false);
      return;
    }
    if (draft?.apiKey !== undefined || revealedApiKey !== undefined || !provider || !hasStoredApiKey) {
      setShowApiKey(true);
      return;
    }

    const requestGeneration = apiKeyRequestGeneration.current + 1;
    apiKeyRequestGeneration.current = requestGeneration;
    setApiKeyBusy(true);
    setFeedback(undefined);
    try {
      const apiKey = await invokeGetAiRouteApiKey(provider.id);
      if (apiKeyRequestGeneration.current !== requestGeneration) return;
      setRevealedApiKey(apiKey);
      setShowApiKey(true);
    } catch (reason) {
      if (apiKeyRequestGeneration.current !== requestGeneration) return;
      setFeedback({
        kind: 'error',
        labelKey: 'settings.ai.keyLoadFailed',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (apiKeyRequestGeneration.current === requestGeneration) setApiKeyBusy(false);
    }
  };

  const handlePresetChange = (preset: AiProviderPresetDefinition | null): void => {
    invalidateModelRequest();
    apiKeyRequestGeneration.current += 1;
    setApiKeyBusy(false);
    setRevealedApiKey(undefined);
    setShowApiKey(false);
    if (!preset) {
      setDraft(undefined);
      setAdvancedOpen(false);
      setProviderModels([]);
      setModelCatalogMode('explicit');
      setFeedback(undefined);
      return;
    }
    setDraft({ ...preset });
    setAdvancedOpen(preset.preset === 'custom');
    setProviderModels(preset.model ? [{ id: preset.model }] : []);
    setModelCatalogMode(preset.preset === 'custom' ? 'explicit' : 'inherited');
    setModelDiscoveryError(undefined);
    setFeedback(undefined);
  };

  const handleLoadModels = async (): Promise<DiscoveredModel[] | undefined> => {
    if (!draft || !canTest) return undefined;
    const requestGeneration = modelRequestGeneration.current + 1;
    modelRequestGeneration.current = requestGeneration;
    setModelBusy(true);
    setModelDiscoveryError(undefined);
    setFeedback(undefined);
    try {
      const found = await invokeListAiModels(draftConfig(draft, provider?.id));
      if (modelRequestGeneration.current !== requestGeneration) return undefined;
      setFeedback({
        kind: 'success',
        message: t('settings.ai.connectionSuccess', { count: found.length }),
      });
      return found;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (modelRequestGeneration.current === requestGeneration) {
        setModelDiscoveryError(message);
        setFeedback({ kind: 'error', message });
      }
      throw reason;
    } finally {
      if (modelRequestGeneration.current === requestGeneration) setModelBusy(false);
    }
  };

  const handleModelsChange = (models: ProviderModelDraft[]): void => {
    declarationRequestGeneration.current += 1;
    setModelCatalogMode('explicit');
    setProviderModels(models);
    setModelDiscoveryError(undefined);
    setDraft((current) => {
      if (!current) return current;
      const ids = models.map((model) => model.id.trim()).filter(Boolean);
      return ids.includes(current.model)
        ? current
        : {
            ...current,
            model: ids[0] ?? '',
            modelDefinition: undefined,
            reasoningEffort: undefined,
          };
    });
  };

  const handleProfileChange = (profile: ProviderProfileId): void => {
    invalidateModelRequest();
    const kind = profileProtocol(profile);
    const preset = PRESET_OPTIONS.find((item) => resolveProviderProfile(item) === profile);
    if (modelCatalogMode === 'inherited') {
      const model = preset?.model ?? '';
      setProviderModels(model ? [{ id: model }] : []);
      setDraft((current) => current ? {
        ...current,
        profile,
        kind,
        model,
        modelDefinition: undefined,
        reasoningEffort: undefined,
      } : current);
    } else {
      setModelCatalogMode('explicit');
      setProviderModels((models) => models.map((model) => {
        const contextWindow = model.contextWindow ?? model.definition?.contextWindow;
        const maxOutputTokens = model.maxOutputTokens ?? model.definition?.maxOutputTokens;
        return {
          id: model.id,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        };
      }));
      setDraft((current) => current ? {
        ...current,
        profile,
        kind,
        modelDefinition: undefined,
        reasoningEffort: undefined,
      } : current);
    }
    setModelDiscoveryError(undefined);
    setFeedback(undefined);
  };

  const handleDeclareModel = async (index: number): Promise<void> => {
    const model = providerModels[index];
    if (!draft || !model?.id.trim()) return;
    const requestGeneration = declarationRequestGeneration.current + 1;
    declarationRequestGeneration.current = requestGeneration;
    const modelIdentity = model;
    setModelBusy(true);
    setFeedback(undefined);
    try {
      const config = draftConfig({ ...draft, model: model.id.trim(), modelDefinition: undefined }, provider?.id);
      const { apiKey: _apiKey, ...providerConfig } = config;
      const definition = await invoke<ModelDefinition>('ai_model_declaration_template', { provider: providerConfig });
      if (declarationRequestGeneration.current !== requestGeneration) return;
      setModelCatalogMode('explicit');
      setProviderModels((current) => current.map((item) => (
        item === modelIdentity ? { ...item, definition } : item
      )));
    } catch (reason) {
      setFeedback({
        kind: 'error',
        labelKey: 'settings.ai.saveFailed',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (declarationRequestGeneration.current === requestGeneration) setModelBusy(false);
    }
  };

  const handleResetModels = (): void => {
    if (!draft) return;
    const profile = resolveProviderProfile(draft);
    const definition = PRESET_OPTIONS.find((item) => resolveProviderProfile(item) === profile);
    if (!definition) return;
    const defaultModel = definition?.model ?? '';
    declarationRequestGeneration.current += 1;
    setModelCatalogMode('inherited');
    setProviderModels(defaultModel ? [{ id: defaultModel }] : []);
    setDraft((current) => current ? { ...current, model: defaultModel, modelDefinition: undefined } : current);
    setFeedback(undefined);
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      invalidateModelRequest();
      apiKeyRequestGeneration.current += 1;
    }
    onOpenChange(nextOpen);
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || !canSave) return;
    const saveGeneration = ++modelRequestGeneration.current;
    setBusy(true);
    setFeedback(undefined);
    let providerId = provider?.id;
    try {
      const inheritedResolved = modelCatalogMode === 'inherited'
        ? await (async () => {
            const { apiKey: _apiKey, ...modelConfig } = draftConfig(
              { ...draft, modelDefinition: undefined },
              provider?.id,
            );
            return invoke<ModelDefinition & { modelId: string }>('ai_resolve_model', { provider: modelConfig });
          })()
        : undefined;
      const resolvedEntries = modelCatalogMode !== 'explicit'
        ? []
        : await Promise.all(providerModels.map(async (model) => {
            if (model.definition) {
              return [model.id.trim(), modelDefinitionForSave(model, model.definition)] as const;
            }
            const config = draftConfig({ ...draft, model: model.id.trim(), modelDefinition: undefined }, provider?.id);
            const { apiKey: _apiKey, ...modelConfig } = config;
            try {
              const resolved = await invoke<ModelDefinition & { modelId: string }>('ai_resolve_model', { provider: modelConfig });
              return [model.id.trim(), modelDefinitionForSave(model, modelDefinitionOf(resolved))] as const;
            } catch (reason) {
              if (!isUnknownModelFailure(reason)) throw reason;
              const fallback = await invoke<ModelDefinition>('ai_model_declaration_template', { provider: modelConfig });
              return [model.id.trim(), modelDefinitionForSave(model, fallback)] as const;
            }
          }));
      const selectedDefinition = modelCatalogMode === 'inherited'
        ? inheritedResolved && modelDefinitionOf(inheritedResolved)
        : modelCatalogMode === 'explicit'
          ? resolvedEntries.find(([modelId]) => modelId === draft.model)?.[1]
          : providerModels.find((model) => model.id.trim() === draft.model)?.definition;
      const changes = {
        modelDefinition: selectedDefinition,
        name: draft.name.trim(),
        kind: draft.kind,
        profile: resolveProviderProfile(draft),
        baseUrl: draft.baseUrl.trim(),
        model: draft.model,
        ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
        requiresApiKey: draft.requiresApiKey,
      };
      if (modelRequestGeneration.current !== saveGeneration) return;
      if (routeSnapshot) {
        providerId ??= `route-${crypto.randomUUID()}`;
      } else if (!nativeRouteMode && provider) {
        updateProvider(provider.id, changes);
      } else if (!nativeRouteMode) {
        const newProviderId = addProvider(draft.preset, changes);
        providerId = newProviderId;
      } else throw new Error(t('settings.ai.routeStateUnavailable'));
      if (!providerId) throw new Error(t('settings.ai.providerSaveFailed'));
      if (routeSnapshot) {
        const existing=routeSnapshot.routes.find(route=>route.id===providerId);
        const route={
          ...(existing ?? { id:providerId, revision:routeSnapshot.revision, replayDomainId:'pending', auth:draft.requiresApiKey?{kind:'keychain' as const,reference:'pending'}:{kind:'none' as const}, timeouts:{requestHeadersMs:30000,firstByteMs:30000,streamIdleMs:300000} }),
          auth:draft.requiresApiKey?(existing?.auth.kind==='keychain'?existing.auth:{kind:'keychain' as const,reference:'pending'}):{kind:'none' as const},
          displayName:draft.name.trim(), adapterId:(draft.kind==='openAi'?'responses':draft.kind==='ollama'?'ollama':draft.kind==='anthropicMessages'?'anthropic-messages':'chat-completions') as 'responses'|'ollama'|'anthropic-messages'|'chat-completions',
          baseUrl:draft.baseUrl.trim(), presetId:resolveProviderProfile(draft), retryPolicy:{...DEFAULT_RETRY_POLICY},
          models:modelCatalogMode==='explicit'?Object.fromEntries(resolvedEntries):undefined,
          modelOverrides:modelCatalogMode==='overrides'?existing?.modelOverrides:undefined,
          defaults:{routeId:providerId,modelId:draft.model,...(draft.reasoningEffort?{reasoningEffort:draft.reasoningEffort}:{})},
        };
        const defaultSelection = routeSnapshot.defaultSelection?.routeId === providerId
          && !providerModels.some((model) => model.id.trim() === routeSnapshot.defaultSelection?.modelId)
          ? route.defaults
          : routeSnapshot.defaultSelection ?? route.defaults;
        await saveRoutes([...routeSnapshot.routes.filter(item=>item.id!==providerId),route],defaultSelection,draft.apiKey?.trim()?{[providerId]:draft.apiKey.trim()}:{});
      }
      onSaved(providerId);
      handleOpenChange(false);
    } catch (reason) {
      if (modelRequestGeneration.current !== saveGeneration) return;
      setFeedback({
        kind: 'error',
        labelKey: 'settings.ai.saveFailed',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (modelRequestGeneration.current === saveGeneration) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <CompactDialogContent className="max-w-xl [&_[data-slot=dialog-close]]:size-6">
        <CompactDialogHeader
          title={t(provider ? 'settings.ai.editProviderTitle' : 'settings.ai.addProviderTitle')}
          description={provider
            ? t('settings.ai.editProviderDescription', { name: provider.name })
            : t('settings.ai.addProviderDescription')}
        />

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <CompactDialogBody
            data-slot="provider-dialog-scroll-area"
            className="native-scrollbar-default @container gap-4"
          >
            <FieldGroup className="gap-4">
              {!provider && <Field>
                <FieldLabel htmlFor="ai-new-provider-preset">{t('settings.ai.chooseProvider')}</FieldLabel>
                <Combobox
                  items={PRESET_OPTIONS}
                  value={selectedPreset}
                  itemToStringLabel={(preset) => preset.name}
                  itemToStringValue={(preset) => preset.name}
                  onValueChange={handlePresetChange}
                  disabled={Boolean(provider)}
                >
                  <ComboboxInput
                    id="ai-new-provider-preset"
                    className={SYSTEM_INPUT_GROUP_CLASS}
                    placeholder={t('settings.ai.chooseProviderPlaceholder')}
                    autoComplete="off"
                    disabled={Boolean(provider)}
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>{t('settings.ai.providerNoResults')}</ComboboxEmpty>
                    <ComboboxList>
                      {(preset: AiProviderPresetDefinition) => {
                        const PresetIcon = PRESET_ICONS[preset.preset];
                        return (
                          <ComboboxItem
                            key={preset.preset}
                            value={preset}
                            showIndicator={false}
                            className="py-1.5 pr-1.5 [&>svg]:size-4!"
                          >
                            <PresetIcon aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                            <Badge
                              variant={preset.kind === 'ollama' ? 'secondary' : 'outline'}
                              className="ml-auto"
                            >
                              {preset.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                            </Badge>
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>}

              {draft && (
                <Field>
                  <FieldLabel htmlFor="ai-new-provider-name">{t('settings.ai.providerName')}</FieldLabel>
                  <Input
                    id="ai-new-provider-name"
                    className={SYSTEM_INPUT_CLASS}
                    value={draft.name}
                    placeholder={t('settings.ai.providerNamePlaceholder')}
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                </Field>
              )}

              {draft?.requiresApiKey && (
                <Field>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="ai-new-provider-key">
                      {t('settings.ai.apiKey')}
                      <span className="text-muted-foreground">{t('settings.ai.required')}</span>
                    </FieldLabel>
                    {provider && (
                      <Badge variant={hasStoredApiKey ? 'secondary' : 'outline'}>
                        {t(hasStoredApiKey ? 'settings.ai.keyStored' : 'settings.ai.keyMissing')}
                      </Badge>
                    )}
                  </div>
                  <InputGroup className={SYSTEM_INPUT_GROUP_CLASS}>
                    <InputGroupInput
                      id="ai-new-provider-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={draft.apiKey ?? (showApiKey ? revealedApiKey ?? '' : '')}
                      placeholder={hasStoredApiKey ? '••••••••' : 'sk-...'}
                      onChange={(event) => handleApiKeyChange(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label={t(showApiKey ? 'settings.ai.hideApiKey' : 'settings.ai.showApiKey')}
                        aria-pressed={showApiKey}
                        disabled={apiKeyBusy}
                        onClick={() => void handleApiKeyVisibility()}
                      >
                        {apiKeyBusy ? <Spinner /> : showApiKey ? <EyeOffIcon /> : <EyeIcon />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              )}

            </FieldGroup>

            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              className="rounded-lg border"
            >
              <CollapsibleTrigger
                render={(
                  <Button
                    type="button"
                    variant="plain"
                    className="h-auto w-full justify-between rounded-lg px-3 py-2.5"
                    disabled={!draft}
                  />
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Settings2Icon data-icon="inline-start" />
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span>{t('settings.ai.advancedSettings')}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('settings.ai.advancedSettingsDescription')}
                    </span>
                  </span>
                </span>
                <ChevronDownIcon
                  data-icon="inline-end"
                  className={cn('transition-transform', advancedOpen && 'rotate-180')}
                />
              </CollapsibleTrigger>

              <CollapsibleContent>
                <Separator />
                <FieldGroup className="gap-3 p-3 @min-[30rem]:grid @min-[30rem]:grid-cols-2">
                  <Field data-disabled={!draft || undefined}>
                    <div className="flex items-center gap-1">
                      <FieldLabel htmlFor="ai-provider-profile">{t('settings.ai.profile')}</FieldLabel>
                      {profileCapabilityLabel && (
                        <TooltipProvider delay={100}>
                          <Tooltip>
                            <TooltipTrigger
                              render={(
                                <Button
                                  type="button"
                                  variant="plain"
                                  size="xs"
                                  className="relative size-4 p-0 after:absolute after:-inset-1"
                                  aria-label={profileCapabilityLabel}
                                />
                              )}
                            >
                              <InfoIcon />
                            </TooltipTrigger>
                            <TooltipContent align="start" className="max-w-sm break-words">
                              {profileCapabilityLabel}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                    <Combobox
                      items={PROVIDER_PROFILE_IDS}
                      value={draft ? resolveProviderProfile(draft) : null}
                      onValueChange={(profile) => {
                        if (!profile || !draft) return;
                        handleProfileChange(profile);
                      }}
                    >
                      <ComboboxInput id="ai-provider-profile" className={SYSTEM_INPUT_GROUP_CLASS} disabled={!draft} />
                      <ComboboxContent>
                        <ComboboxEmpty>{t('settings.ai.providerNoResults')}</ComboboxEmpty>
                        <ComboboxList>
                          {(profile: (typeof PROVIDER_PROFILE_IDS)[number]) => {
                            const ProfileIcon = PROFILE_ICONS[profile];
                            return (
                              <ComboboxItem
                                key={profile}
                                value={profile}
                                className="[&>svg]:size-4!"
                              >
                                <ProfileIcon aria-hidden />
                                <span>{profile}</span>
                              </ComboboxItem>
                            );
                          }}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                    {draft && resolution.status !== 'ready' && (
                      <FieldDescription aria-live="polite">
                        {resolution.status === 'error'
                          ? isUnknownModelFailure(resolution.error)
                            ? t('settings.ai.unknownModelDescription')
                            : resolution.error
                          : t('settings.ai.capabilitiesLoading')}
                      </FieldDescription>
                    )}
                  </Field>

                  <Field data-disabled={!draft || undefined}>
                    <FieldLabel htmlFor="ai-new-provider-protocol">{t('settings.ai.protocol')}</FieldLabel>
                    <Input
                      id="ai-new-provider-protocol"
                      className={SYSTEM_INPUT_CLASS}
                      value={draft ? t(PROTOCOL_LABEL_KEYS[draft.kind]) : ''}
                      placeholder={t('settings.ai.chooseProviderFirst')}
                      disabled
                      readOnly
                    />
                  </Field>

                  <Field
                    className="@min-[30rem]:col-span-2"
                    data-disabled={!draft || undefined}
                    data-invalid={Boolean(draft && !requestEndpoint) || undefined}
                  >
                    <div className="flex items-center gap-1">
                      <FieldLabel htmlFor="ai-new-provider-url">{t('settings.ai.baseUrl')}</FieldLabel>
                      {requestEndpointLabel && (
                        <TooltipProvider delay={100}>
                          <Tooltip>
                            <TooltipTrigger
                              render={(
                                <Button
                                  type="button"
                                  variant="plain"
                                  size="xs"
                                  className="relative size-4 p-0 after:absolute after:-inset-1"
                                  aria-label={requestEndpointLabel}
                                />
                              )}
                            >
                              <InfoIcon />
                            </TooltipTrigger>
                            <TooltipContent align="start">{requestEndpointLabel}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                    <Input
                      id="ai-new-provider-url"
                      className={SYSTEM_INPUT_CLASS}
                      value={draft?.baseUrl ?? ''}
                      placeholder="https://..."
                      disabled={!draft}
                      aria-invalid={Boolean(draft && !requestEndpoint) || undefined}
                      onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                  </Field>

                  <Separator className="@min-[30rem]:col-span-2" />
                  <div className="@min-[30rem]:col-span-2">
                    <ProviderModelCatalogEditor
                      models={providerModels}
                      defaultModelId={draft?.model ?? ''}
                      inherited={modelCatalogMode === 'inherited'}
                      canReset={Boolean(
                        draft
                        && PRESET_OPTIONS.some((item) => (
                          resolveProviderProfile(item) === resolveProviderProfile(draft)
                        ))
                        && modelCatalogMode !== 'inherited'
                      )}
                      disabled={!draft || busy || modelBusy}
                      discovering={modelBusy}
                      discoveryError={modelDiscoveryError}
                      onChange={handleModelsChange}
                      onDefaultChange={(model) => updateDraft({ model, reasoningEffort: undefined })}
                      onDiscover={handleLoadModels}
                      onDeclare={handleDeclareModel}
                      onReset={handleResetModels}
                    />
                  </div>
                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
          </CompactDialogBody>

          <CompactDialogFooter className="sm:justify-between">
            <div className="flex w-full min-w-0 items-center gap-2 sm:flex-1">
              {onDelete && (
                <Button type="button" variant="destructiveOutline" size="xs" onClick={onDelete}>
                  {t('settings.ai.deleteProvider')}
                </Button>
              )}
              {feedback && (
                <div
                  role={feedback.kind === 'error' ? 'alert' : 'status'}
                  aria-atomic="true"
                  className={cn(
                    'flex h-6 min-w-0 items-center gap-0.5 text-xs font-medium leading-none',
                    feedback.kind === 'error' ? 'text-destructive' : 'text-app-success',
                  )}
                >
                  <span className="truncate">
                    {t(feedback.labelKey ?? (feedback.kind === 'error' ? 'settings.ai.connectionFailed' : 'settings.ai.ready'))}
                  </span>
                  <TooltipProvider delay={250}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="plain"
                            size="xs"
                            className="size-4 shrink-0 p-0"
                            aria-label={`${t(feedback.labelKey ?? (feedback.kind === 'error' ? 'settings.ai.connectionFailed' : 'settings.ai.ready'))}: ${feedback.message}`}
                          />
                        }
                      >
                        {feedback.kind === 'error' ? <CircleAlertIcon /> : <CheckCircle2Icon />}
                      </TooltipTrigger>
                      <TooltipContent align="start" className="max-w-sm break-words">
                        {feedback.message}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!canSave || busy}>
                {t('common.save')}
              </Button>
            </div>
          </CompactDialogFooter>
        </form>
      </CompactDialogContent>
    </Dialog>
  );
};

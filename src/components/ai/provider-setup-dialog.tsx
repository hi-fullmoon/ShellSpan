import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  RefreshCwIcon,
  ServerIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_RETRY_POLICY, RETRY_LIMITS, parseRetryPolicy } from '@/lib/ai/retry-policy';
import { Button } from '@/components/ui/button';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import {
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
  DeepSeekBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
} from './provider-brand-icons';

import { PROVIDER_PROFILE_IDS, resolveProviderProfile, useResolvedModel, profileProtocol, loadResolvedModel, type ModelDefinition, type Support } from '@/lib/ai/provider-contract';

type ProviderDraft = Omit<AiProviderProfile, 'id'> & { apiKey?: string };

function retryPolicyValid(value: unknown): boolean {
  try { parseRetryPolicy(value); return true; } catch { return false; }
}

interface ProviderSetupDialogProps {
  open: boolean;
  provider?: AiProviderProfile;
  addingModel?: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (providerId: string) => void;
  onDelete?: () => void;
}

type Feedback = {
  kind: 'error' | 'success';
  message: string;
};

const PRESET_OPTIONS = [...AI_PROVIDER_PRESETS];

const PRESET_ICONS: Record<AiProviderPreset, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  ollama: OllamaBrandIcon,
  openai: OpenAiBrandIcon,
  anthropic: ServerIcon,
  deepseek: DeepSeekBrandIcon,
  minimax: MiniMaxBrandIcon,
  kimi: KimiBrandIcon,
  qwen: ServerIcon,
  glm: ServerIcon,
  custom: ServerIcon,
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
    retryPolicy: parseRetryPolicy(draft.retryPolicy),
    kind: draft.kind,
    profile: resolveProviderProfile(draft),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model,
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    requiresApiKey: draft.requiresApiKey,
    ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
}

export const ProviderSetupDialog: React.FC<ProviderSetupDialogProps> = ({
  open,
  provider,
  addingModel = false,
  onOpenChange,
  onSaved,
  onDelete,
}) => {
  const { t } = useI18n();
  const addProvider = useAiSettingsStore((state) => state.addProvider);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const [draft, setDraft] = useState<ProviderDraft>();
  const resolution = useResolvedModel(draft ? { ...draft, id: provider?.id ?? 'draft' } : undefined);
  const [models, setModels] = useState<string[]>([]);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const routeSnapshot = useLlmRoutesStore((state) => state.snapshot);
  const hydrateRoutes = useLlmRoutesStore((state) => state.hydrate);
  const saveRoutes = useLlmRoutesStore((state) => state.save);
  const routeModels = useLlmRoutesStore((state) => state.modelsByRoute);
  const nativeRouteMode = isTauriRuntime();
  const modelRequestGeneration = useRef(0);
  useEffect(() => { if (open && !routeSnapshot) void hydrateRoutes(); }, [open, routeSnapshot, hydrateRoutes]);

  const invalidateModelRequest = (): void => {
    modelRequestGeneration.current += 1;
    setBusy(false);
  };

  useEffect(() => {
    modelRequestGeneration.current += 1;
    if (!open) {
      setBusy(false);
      return;
    }
    setDraft(provider ? {
      ...provider,
      ...(addingModel ? { model: '', modelDefinition: undefined, reasoningEffort: undefined } : {}),
    } : undefined);
    setModels([]);
    setHasStoredApiKey(false);
    setShowApiKey(false);
    setBusy(false);
    setFeedback(undefined);
  }, [open, provider, addingModel]);

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
  const canTest = Boolean(
    draft
    && retryPolicyValid(draft.retryPolicy)
    && requestEndpoint
    && (!draft.requiresApiKey || draft.apiKey?.trim() || (provider && hasStoredApiKey)),
  );
  const canSave = Boolean(
    canTest
    && draft?.name.trim()
    && draft.model.trim()
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
    setFeedback(undefined);
  };


  const updateDefinition = (changes: Partial<ModelDefinition>): void => {
    if (draft?.modelDefinition) updateDraft({ modelDefinition: { ...draft.modelDefinition, ...changes } });
  };
  const enableDeclaration = async (): Promise<void> => {
    if (!draft) return;
    const identity = draft;
    try {
      const definition = resolution.status === 'ready' ? {
        contextWindow: resolution.model.contextWindow, maxOutputTokens: resolution.model.maxOutputTokens,
        toolCalling: resolution.model.toolCalling, textInput: resolution.model.textInput,
        imageInput: resolution.model.imageInput, reasoning: resolution.model.reasoning,
        compat: resolution.model.compat, vision: resolution.model.vision,
      } : await invoke<ModelDefinition>('ai_model_declaration_template', { provider: { id: provider?.id ?? 'draft', kind: draft.kind, profile: resolveProviderProfile(draft), baseUrl: draft.baseUrl, model: draft.model, requiresApiKey: false } });
      setDraft(current => current === identity ? { ...current, modelDefinition: definition } : current);
    } catch (error) { setFeedback({ kind: 'error', message: String(error) }); }
  };

  const handlePresetChange = (preset: AiProviderPresetDefinition | null): void => {
    invalidateModelRequest();
    setShowApiKey(false);
    if (!preset) {
      setDraft(undefined);
      setModels([]);
      setFeedback(undefined);
      return;
    }
    setDraft({ ...preset });
    setModels([]);
    setFeedback(undefined);
  };

  const handleLoadModels = async (): Promise<void> => {
    if (!draft || !canTest) return;
    const requestGeneration = modelRequestGeneration.current + 1;
    modelRequestGeneration.current = requestGeneration;
    setBusy(true);
    setFeedback(undefined);
    try {
      const found = await invokeListAiModels(draftConfig(draft, provider?.id));
      if (modelRequestGeneration.current !== requestGeneration) return;
      setModels(found);
      if (!draft.model.trim() && found[0]) {
        setDraft((current) => current ? { ...current, model: found[0] } : current);
      }
      setFeedback({
        kind: 'success',
        message: t('settings.ai.connectionSuccess', { count: found.length }),
      });
    } catch (reason) {
      if (modelRequestGeneration.current !== requestGeneration) return;
      setFeedback({
        kind: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (modelRequestGeneration.current === requestGeneration) setBusy(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) invalidateModelRequest();
    onOpenChange(nextOpen);
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || !canSave) return;
    const saveGeneration = ++modelRequestGeneration.current;
    setBusy(true);
    setFeedback(undefined);
    const changes = {
      modelDefinition: draft.modelDefinition,
      retryPolicy: parseRetryPolicy(draft.retryPolicy),
      name: draft.name.trim(),
      kind: draft.kind,
    profile: resolveProviderProfile(draft),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model,
      ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
      requiresApiKey: draft.requiresApiKey,
    };
    let providerId = provider?.id;
    try {
      const { apiKey: _apiKey, ...modelConfig } = draftConfig(draft, provider?.id);
      const resolved = await invoke<ModelDefinition & { modelId: string }>('ai_resolve_model', { provider: modelConfig });
      if (modelRequestGeneration.current !== saveGeneration) return;
      if (routeSnapshot) {
        providerId ??= `route-${crypto.randomUUID()}`;
      } else if (!nativeRouteMode && provider) {
        updateProvider(provider.id, changes);
      } else if (!nativeRouteMode) {
        const newProviderId = addProvider(draft.preset, changes);
        providerId = newProviderId;
      } else throw new Error('ROUTE_STATE_NOT_LOADED');
      if (!providerId) throw new Error('No AI provider was saved');
      if (routeSnapshot) {
        const existing=routeSnapshot.routes.find(route=>route.id===providerId);
        const existingModels=existing?.models ?? Object.fromEntries((routeModels[providerId] ?? []).map(model=>[
          model.modelId,
          {contextWindow:model.contextWindow,maxOutputTokens:model.maxOutputTokens,toolCalling:model.toolCalling,textInput:model.textInput,imageInput:model.imageInput,reasoning:model.reasoning,compat:model.compat,vision:model.vision},
        ]));
        const route={
          ...(existing ?? { id:providerId, revision:routeSnapshot.revision, replayDomainId:'pending', auth:draft.requiresApiKey?{kind:'keychain' as const,reference:'pending'}:{kind:'none' as const}, timeouts:{requestHeadersMs:30000,firstByteMs:30000,streamIdleMs:300000} }),
          auth:draft.requiresApiKey?(existing?.auth.kind==='keychain'?existing.auth:{kind:'keychain' as const,reference:'pending'}):{kind:'none' as const},
          displayName:draft.name.trim(), adapterId:(draft.kind==='openAi'?'responses':draft.kind==='ollama'?'ollama':draft.kind==='anthropicMessages'?'anthropic-messages':'chat-completions') as 'responses'|'ollama'|'anthropic-messages'|'chat-completions',
          baseUrl:draft.baseUrl.trim(), presetId:resolveProviderProfile(draft), retryPolicy:parseRetryPolicy(draft.retryPolicy),
          models:{...existingModels,[draft.model]:{contextWindow:resolved.contextWindow,maxOutputTokens:resolved.maxOutputTokens,toolCalling:resolved.toolCalling,textInput:resolved.textInput,imageInput:resolved.imageInput,reasoning:resolved.reasoning,compat:resolved.compat,vision:resolved.vision}},
          modelOverrides:undefined,
          defaults:{routeId:providerId,modelId:draft.model,...(draft.reasoningEffort?{reasoningEffort:draft.reasoningEffort}:{})},
        };
        await saveRoutes([...routeSnapshot.routes.filter(item=>item.id!==providerId),route],routeSnapshot.defaultSelection ?? route.defaults,draft.apiKey?.trim()?{[providerId]:draft.apiKey.trim()}:{});
      }
      onSaved(providerId);
      handleOpenChange(false);
    } catch (reason) {
      if (modelRequestGeneration.current !== saveGeneration) return;
      setFeedback({
        kind: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (modelRequestGeneration.current === saveGeneration) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <CompactDialogContent className="max-w-2xl [&_[data-slot=dialog-close]]:size-6">
        <CompactDialogHeader
          title={addingModel ? 'Add model' : t(provider ? 'settings.ai.editProviderTitle' : 'settings.ai.addProviderTitle')}
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
            className="@container gap-5"
          >
            <FieldGroup className="gap-2.5 @min-[30rem]:grid @min-[30rem]:grid-cols-2">
              <Field>
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
              </Field>

              <Field data-disabled={!draft || undefined}>
                <FieldLabel htmlFor="ai-new-provider-name">{t('settings.ai.providerName')}</FieldLabel>
                <Input
                  id="ai-new-provider-name"
                  className={SYSTEM_INPUT_CLASS}
                  value={draft?.name ?? ''}
                  placeholder={t('settings.ai.providerNamePlaceholder')}
                  disabled={!draft}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </Field>
            </FieldGroup>

            <FieldGroup className="gap-2.5 @min-[30rem]:grid @min-[30rem]:grid-cols-2">
              <Field data-disabled={!draft || undefined}>
                <FieldLabel htmlFor="ai-provider-profile">{t('settings.ai.profile')}</FieldLabel>
                <Combobox items={PROVIDER_PROFILE_IDS} value={draft ? resolveProviderProfile(draft) : null}
                  onValueChange={(profile) => {
                    if (!profile || !draft) return;
                    const kind = profileProtocol(profile);
                    updateDraft({ profile, kind, reasoningEffort: undefined });
                  }}>
                  <ComboboxInput id="ai-provider-profile" className={SYSTEM_INPUT_GROUP_CLASS} disabled={!draft} />
                  <ComboboxContent>
                    <ComboboxEmpty>{t('settings.ai.providerNoResults')}</ComboboxEmpty>
                    <ComboboxList>{(profile) => <ComboboxItem key={profile} value={profile}>{profile}</ComboboxItem>}</ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {draft && <FieldDescription aria-live="polite">{resolution.status === 'ready'
                  ? `${t('settings.ai.profileLimits', { context: resolution.model.contextWindow, output: resolution.model.maxOutputTokens })} · ${t(resolution.model.source === 'builtinCatalog' ? 'settings.ai.builtinSource' : 'settings.ai.userSource')}`
                  : resolution.status === 'error' ? resolution.error : t('settings.ai.capabilitiesLoading')}</FieldDescription>}
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

              <Field data-disabled={!draft || undefined} data-invalid={Boolean(draft && !requestEndpoint) || undefined}>
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="ai-new-provider-url">{t('settings.ai.baseUrl')}</FieldLabel>
                  {requestEndpointLabel && (
                    <TooltipProvider delay={100}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="plain"
                              size="xs"
                              className="relative size-4 p-0 after:absolute after:-inset-1"
                              aria-label={requestEndpointLabel}
                            />
                          }
                        >
                          <InfoIcon />
                        </TooltipTrigger>
                        <TooltipContent align="start">
                          {requestEndpointLabel}
                        </TooltipContent>
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

              <Field data-disabled={!draft || undefined} className="@min-[30rem]:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor="ai-new-provider-model">{t('settings.ai.model')}</FieldLabel>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    disabled={!canTest || busy}
                    onClick={() => void handleLoadModels()}
                  >
                    {busy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                    {t('settings.ai.loadModels')}
                  </Button>
                </div>
                <Combobox
                  items={models}
                  value={draft?.model ?? ''}
                  inputValue={draft?.model ?? ''}
                  onValueChange={(model) => {
                    if (model) updateDraft({ model });
                  }}
                  onInputValueChange={(model) => updateDraft({ model })}
                >
                  <ComboboxInput
                    id="ai-new-provider-model"
                    className={SYSTEM_INPUT_GROUP_CLASS}
                    placeholder={draft
                      ? t('settings.ai.modelPlaceholder')
                      : t('settings.ai.chooseProviderFirst')}
                    disabled={!draft}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>{t('settings.ai.modelNoResults')}</ComboboxEmpty>
                    <ComboboxList>
                      {(model) => (
                        <ComboboxItem key={model} value={model}>
                          {model}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>
            </FieldGroup>
            {draft && <FieldGroup>
              <Field>
                <FieldDescription>{t('settings.ai.declaredHint')}</FieldDescription>
                <Button variant="outline" size="sm" onClick={() => draft.modelDefinition ? updateDraft({ modelDefinition: undefined }) : void enableDeclaration()}>
                  {t(draft.modelDefinition ? 'settings.ai.useCatalog' : 'settings.ai.declareModel')}
                </Button>
                {resolution.status === 'error' && <Button variant="ghost" size="sm" onClick={() => void loadResolvedModel({ ...draft, id: provider?.id ?? 'draft' }, true).catch(() => {})}>{t('settings.ai.capabilityRetry')}</Button>}
              </Field>
              {draft.modelDefinition && <>
                <Field><FieldLabel htmlFor="model-context">{t('settings.ai.contextWindow')}</FieldLabel><Input id="model-context" type="number" value={draft.modelDefinition.contextWindow} onChange={e => updateDefinition({ contextWindow: Number(e.target.value) })} /></Field>
                <Field><FieldLabel htmlFor="model-output">{t('settings.ai.maxOutput')}</FieldLabel><Input id="model-output" type="number" value={draft.modelDefinition.maxOutputTokens} onChange={e => updateDefinition({ maxOutputTokens: Number(e.target.value) })} /></Field>
                {(['toolCalling', 'imageInput'] as const).map(field => <Field key={field}>
                  <FieldLabel htmlFor={`model-${field}`}>{t(field === 'toolCalling' ? 'settings.ai.toolSupport' : 'settings.ai.imageSupport')}</FieldLabel>
                  <Combobox items={['unknown', 'unsupported', 'supported'] as Support[]} value={draft.modelDefinition![field]} onValueChange={value => {
                    if (!value) return;
                    updateDefinition({ [field]: value, ...(field === 'imageInput' ? { vision: value === 'supported' ? {
                      maxRequestImages: 20, maxRequestImageBytes: 20971520, reservedTokensPerImage: 4096,
                      imageTokenBudgetPolicy: 'User-declared application admission estimate for normalized PNG; not provider usage.',
                    } : undefined } : {}) });
                  }}><ComboboxInput id={`model-${field}`} /><ComboboxContent><ComboboxList>{value => <ComboboxItem key={value} value={value}>{value}</ComboboxItem>}</ComboboxList></ComboboxContent></Combobox>
                </Field>)}
                {draft.modelDefinition.vision && (['maxRequestImages', 'maxRequestImageBytes', 'reservedTokensPerImage'] as const).map(field => <Field key={field}>
                  <FieldLabel htmlFor={`model-${field}`}>{t(field === 'maxRequestImages' ? 'settings.ai.imageCount' : field === 'maxRequestImageBytes' ? 'settings.ai.imageBytes' : 'settings.ai.imageTokens')}</FieldLabel>
                  <Input id={`model-${field}`} type="number" value={draft.modelDefinition!.vision![field]} onChange={e => updateDefinition({ vision: { ...draft.modelDefinition!.vision!, [field]: Number(e.target.value) } })} />
                </Field>)}
              </>}
            </FieldGroup>}


            {draft && <FieldGroup className="gap-2.5 @min-[30rem]:grid @min-[30rem]:grid-cols-2">
              <FieldDescription className="@min-[30rem]:col-span-2">{t('settings.ai.retryDescription')}</FieldDescription>
              {(Object.keys(DEFAULT_RETRY_POLICY) as (keyof typeof DEFAULT_RETRY_POLICY)[]).map(key => (
                <Field key={key} data-invalid={!retryPolicyValid(draft.retryPolicy)}>
                  <FieldLabel htmlFor={`retry-${key}`}>{t(`settings.ai.retry.${key}`)}</FieldLabel>
                  <Input
                    id={`retry-${key}`}
                    type="number"
                    min={key === 'maxAttempts' ? 1 : 0}
                    max={key === 'maxAttempts' ? RETRY_LIMITS.maxAttempts : key === 'jitterRatio' ? 1 : RETRY_LIMITS.maxDelayMs}
                    step={key === 'jitterRatio' ? 'any' : 1}
                    value={Number.isFinite((draft.retryPolicy ?? DEFAULT_RETRY_POLICY)[key]) ? (draft.retryPolicy ?? DEFAULT_RETRY_POLICY)[key] : ''}
                    aria-invalid={!retryPolicyValid(draft.retryPolicy)}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      retryPolicy: { ...DEFAULT_RETRY_POLICY, ...current.retryPolicy, [key]: event.target.value === '' ? NaN : Number(event.target.value) },
                    } : current)}
                  />
                </Field>
              ))}
              {!retryPolicyValid(draft.retryPolicy) && <FieldDescription role="alert">{t('settings.ai.retryInvalid')}</FieldDescription>}
            </FieldGroup>}
            <FieldGroup className="gap-2.5">
              <Field data-disabled={!draft || undefined}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor="ai-new-provider-key">
                    {t('settings.ai.apiKey')}
                    {draft?.requiresApiKey && (
                      <span className="text-muted-foreground">{t('settings.ai.required')}</span>
                    )}
                  </FieldLabel>
                  {provider && draft?.requiresApiKey && (
                    <Badge variant={hasStoredApiKey ? 'secondary' : 'outline'}>
                      {t(hasStoredApiKey ? 'settings.ai.keyStored' : 'settings.ai.keyMissing')}
                    </Badge>
                  )}
                </div>
                <InputGroup className={SYSTEM_INPUT_GROUP_CLASS}>
                  <InputGroupInput
                    id="ai-new-provider-key"
                    type={showApiKey ? 'text' : 'password'}
                    value={draft?.apiKey ?? ''}
                    placeholder={hasStoredApiKey ? '••••••••' : 'sk-...'}
                    disabled={!draft || !draft.requiresApiKey}
                    onChange={(event) => updateDraft({ apiKey: event.target.value })}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={t(showApiKey ? 'settings.ai.hideApiKey' : 'settings.ai.showApiKey')}
                      disabled={!draft || !draft.requiresApiKey}
                      onClick={() => setShowApiKey((visible) => !visible)}
                    >
                      {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          </CompactDialogBody>

          <CompactDialogFooter className="sm:justify-between">
            <div className="flex w-full min-w-0 items-center gap-2 sm:flex-1">
              {onDelete && (
                <Button type="button" variant="destructiveOutline" size="xs" onClick={onDelete}>
                  {t('settings.ai.deleteProvider')}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!canTest || busy}
                onClick={() => void handleLoadModels()}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {t('settings.ai.verifyConnection')}
              </Button>
              {feedback && (
                <div
                  role={feedback.kind === 'error' ? 'alert' : 'status'}
                  aria-atomic="true"
                  className={cn(
                    'flex min-w-0 items-center gap-0.5 text-xs font-medium',
                    feedback.kind === 'error' ? 'text-destructive' : 'text-app-success',
                  )}
                >
                  <span className="truncate">
                    {t(feedback.kind === 'error' ? 'settings.ai.connectionFailed' : 'settings.ai.ready')}
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
                            aria-label={`${t(feedback.kind === 'error' ? 'settings.ai.connectionFailed' : 'settings.ai.ready')}: ${feedback.message}`}
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
              <Button type="button" variant="outline" size="xs" onClick={() => handleOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" size="xs" disabled={!canSave || busy}>
                {t('common.save')}
              </Button>
            </div>
          </CompactDialogFooter>
        </form>
      </CompactDialogContent>
    </Dialog>
  );
};

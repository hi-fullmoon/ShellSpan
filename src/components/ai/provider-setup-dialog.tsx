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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
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
  invokeDeleteAiApiKey,
  invokeHasAiApiKey,
  invokeListAiModels,
  invokeStoreAiApiKey,
} from '@/lib/tauri';
import type { LocaleKey } from '@/locales';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderPresetDefinition,
  useAiSettingsStore,
} from '@/stores/aiSettingsStore';
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

type ProviderDraft = Omit<AiProviderProfile, 'id'> & { apiKey?: string };

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
};

const PRESET_OPTIONS = [...AI_PROVIDER_PRESETS];

const PRESET_ICONS: Record<AiProviderPreset, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  ollama: OllamaBrandIcon,
  openai: OpenAiBrandIcon,
  deepseek: DeepSeekBrandIcon,
  minimax: MiniMaxBrandIcon,
  kimi: KimiBrandIcon,
  custom: ServerIcon,
};

const PROTOCOL_LABEL_KEYS: Record<AiProviderKind, LocaleKey> = {
  ollama: 'settings.ai.protocol.ollama',
  openAi: 'settings.ai.protocol.openAi',
  openAiCompatible: 'settings.ai.protocol.openAiCompatible',
};

const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/models',
  '/api/chat',
  '/api/tags',
  '/api/show',
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
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (basePath.endsWith(suffix)) {
      basePath = basePath.slice(0, -suffix.length);
      break;
    }
  }
  if (kind !== 'ollama' && !basePath.endsWith('/v1')) {
    basePath = `${basePath.replace(/\/$/, '')}/v1`;
  }
  const requestPath = kind === 'ollama'
    ? 'api/chat'
    : kind === 'openAi'
      ? 'responses'
      : 'chat/completions';
  url.pathname = `${basePath.replace(/\/$/, '')}/${requestPath}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function draftConfig(
  draft: ProviderDraft,
  providerId?: string,
): AiProviderConnectionConfig {
  return {
    id: providerId ?? 'provider-setup-draft',
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    requiresApiKey: draft.requiresApiKey,
    ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
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
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const [draft, setDraft] = useState<ProviderDraft>();
  const [models, setModels] = useState<string[]>([]);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const modelRequestGeneration = useRef(0);

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
    setDraft(provider ? { ...provider } : undefined);
    setModels([]);
    setHasStoredApiKey(false);
    setShowApiKey(false);
    setBusy(false);
    setFeedback(undefined);
  }, [open, provider]);

  useEffect(() => {
    if (!open || !provider?.requiresApiKey) return;
    let cancelled = false;
    void invokeHasAiApiKey(provider.id)
      .then((stored) => {
        if (!cancelled) setHasStoredApiKey(stored);
      })
      .catch((reason) => {
        if (!cancelled) {
          setHasStoredApiKey(false);
          setFeedback({
            kind: 'error',
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider?.id, provider?.requiresApiKey]);

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
    && requestEndpoint
    && (!draft.requiresApiKey || draft.apiKey?.trim() || (provider && hasStoredApiKey)),
  );
  const canSave = Boolean(
    canTest
    && draft?.name.trim()
    && draft.model.trim(),
  );

  const updateDraft = (changes: Partial<ProviderDraft>): void => {
    invalidateModelRequest();
    setDraft((current) => current ? { ...current, ...changes } : current);
    setFeedback(undefined);
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
    setBusy(true);
    setFeedback(undefined);
    const changes = {
      name: draft.name.trim(),
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
      requiresApiKey: draft.requiresApiKey,
    };
    let providerId = provider?.id;
    try {
      if (provider) {
        if (!draft.requiresApiKey && hasStoredApiKey) {
          await invokeDeleteAiApiKey(provider.id);
        } else if (draft.apiKey?.trim()) {
          await invokeStoreAiApiKey(provider.id, draft.apiKey.trim());
        }
        updateProvider(provider.id, changes);
      } else {
        const newProviderId = addProvider(draft.preset, changes);
        providerId = newProviderId;
        try {
          if (draft.requiresApiKey) {
            await invokeStoreAiApiKey(newProviderId, draft.apiKey?.trim() ?? '');
          }
        } catch (error) {
          removeProvider(newProviderId);
          throw error;
        }
      }
      if (!providerId) throw new Error('No AI provider was saved');
      onSaved(providerId);
      handleOpenChange(false);
    } catch (reason) {
      setFeedback({
        kind: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <CompactDialogContent className="max-w-2xl">
        <CompactDialogHeader
          title={t(provider ? 'settings.ai.editProviderTitle' : 'settings.ai.addProviderTitle')}
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
                <Button type="button" variant="destructiveOutline" size="sm" onClick={onDelete}>
                  {t('settings.ai.deleteProvider')}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
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

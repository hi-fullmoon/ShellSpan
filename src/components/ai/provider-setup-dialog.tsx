import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
  ServerIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import {
  effectiveReasoningEffort,
  isAiReasoningEffort,
  reasoningEffortOptions,
} from '@/lib/ai-reasoning';
import { invokeListAiModels } from '@/lib/tauri';
import type { LocaleKey } from '@/locales';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderPresetDefinition,
  useAiSettingsStore,
} from '@/stores/aiSettingsStore';
import type {
  AiProviderConfig,
  AiProviderKind,
  AiProviderPreset,
  AiProviderProfile,
  AiReasoningEffort,
} from '@/types/ai';
import {
  DeepSeekBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
} from './provider-brand-icons';

type ProviderDraft = Omit<AiProviderProfile, 'id'>;

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

const REASONING_EFFORT_LABEL_KEYS: Record<AiReasoningEffort, LocaleKey> = {
  low: 'ai.reasoningEffort.low',
  high: 'ai.reasoningEffort.high',
  max: 'ai.reasoningEffort.max',
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

function draftConfig(draft: ProviderDraft): AiProviderConfig {
  return {
    id: 'provider-setup-draft',
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
  const [draft, setDraft] = useState<ProviderDraft>();
  const [models, setModels] = useState<string[]>([]);
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
    setShowApiKey(false);
    setBusy(false);
    setFeedback(undefined);
  }, [open, provider]);

  const selectedPreset = useMemo(
    () => PRESET_OPTIONS.find((preset) => preset.preset === draft?.preset) ?? null,
    [draft?.preset],
  );
  const requestEndpoint = draft
    ? buildProviderRequestEndpoint(draft.baseUrl, draft.kind)
    : undefined;
  const availableReasoningEfforts = draft ? reasoningEffortOptions(draft) : [];
  const selectedReasoningEffort = draft ? effectiveReasoningEffort(draft) : undefined;
  const canTest = Boolean(
    draft
    && requestEndpoint
    && (!draft.requiresApiKey || draft.apiKey?.trim()),
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
      const found = await invokeListAiModels(draftConfig(draft));
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

  const handleSave = (): void => {
    if (!draft || !canSave) return;
    const changes = {
      name: draft.name.trim(),
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
      requiresApiKey: draft.requiresApiKey,
      apiKey: draft.apiKey?.trim() || undefined,
    };
    const providerId = provider?.id ?? addProvider(draft.preset, changes);
    if (provider) updateProvider(provider.id, changes);
    onSaved(providerId);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4 pr-12">
          <DialogTitle>
            {t(provider ? 'settings.ai.editProviderTitle' : 'settings.ai.addProviderTitle')}
          </DialogTitle>
          <DialogDescription>
            {t(provider ? 'settings.ai.editProviderDescription' : 'settings.ai.addProviderDescription')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <div
            data-slot="provider-dialog-scroll-area"
            className="min-h-0 overflow-y-auto px-4 py-4"
          >
            <FieldGroup>
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
                          <ComboboxItem key={preset.preset} value={preset}>
                            <PresetIcon aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                            <Badge variant="outline">
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
                  value={draft?.name ?? ''}
                  placeholder={t('settings.ai.providerNamePlaceholder')}
                  disabled={!draft}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </Field>

              {draft?.preset === 'custom' && (
                <Field className="flex-row items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <FieldLabel htmlFor="ai-new-provider-requires-key">
                      {t('settings.ai.authRequired')}
                    </FieldLabel>
                    <FieldDescription>{t('settings.ai.authRequiredHint')}</FieldDescription>
                  </div>
                  <Switch
                    id="ai-new-provider-requires-key"
                    checked={draft.requiresApiKey}
                    onCheckedChange={(requiresApiKey) => updateDraft({ requiresApiKey })}
                  />
                </Field>
              )}

              <Field data-disabled={!draft || undefined}>
                <FieldLabel htmlFor="ai-new-provider-protocol">{t('settings.ai.configurationMethod')}</FieldLabel>
                <Input
                  id="ai-new-provider-protocol"
                  value={draft ? t(PROTOCOL_LABEL_KEYS[draft.kind]) : ''}
                  placeholder={t('settings.ai.chooseProviderFirst')}
                  disabled
                  readOnly
                />
              </Field>

              <Field data-disabled={!draft || undefined}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor="ai-new-provider-key">
                    {t('settings.ai.apiKey')}
                    {draft?.requiresApiKey && (
                      <span className="text-muted-foreground">{t('settings.ai.required')}</span>
                    )}
                  </FieldLabel>
                </div>
                <InputGroup>
                  <InputGroupInput
                    id="ai-new-provider-key"
                    type={showApiKey ? 'text' : 'password'}
                    value={draft?.apiKey ?? ''}
                    placeholder="sk-..."
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
                {draft && !draft.requiresApiKey && (
                  <FieldDescription>{t('settings.ai.noApiKeyHint')}</FieldDescription>
                )}
              </Field>

              <Field data-disabled={!draft || undefined} data-invalid={Boolean(draft && !requestEndpoint) || undefined}>
                <FieldLabel htmlFor="ai-new-provider-url">{t('settings.ai.baseUrl')}</FieldLabel>
                <Input
                  id="ai-new-provider-url"
                  value={draft?.baseUrl ?? ''}
                  placeholder="https://..."
                  disabled={!draft}
                  aria-invalid={Boolean(draft && !requestEndpoint) || undefined}
                  onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                {requestEndpoint && (
                  <FieldDescription className="font-mono break-all">
                    {t('settings.ai.requestEndpoint', { endpoint: requestEndpoint })}
                  </FieldDescription>
                )}
              </Field>

              <Field data-disabled={!draft || undefined}>
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

              {selectedReasoningEffort && availableReasoningEfforts.length > 0 && (
                <Field>
                  <FieldLabel>{t('settings.ai.reasoningEffort')}</FieldLabel>
                  <Select
                    value={selectedReasoningEffort}
                    onValueChange={(value) => {
                      if (isAiReasoningEffort(value)) updateDraft({ reasoningEffort: value });
                    }}
                  >
                    <SelectTrigger aria-label={t('settings.ai.reasoningEffort')}>
                      <SelectValue>
                        {t(REASONING_EFFORT_LABEL_KEYS[selectedReasoningEffort])}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {availableReasoningEfforts.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {t(REASONING_EFFORT_LABEL_KEYS[effort])}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>{t('settings.ai.reasoningEffortHint')}</FieldDescription>
                </Field>
              )}
            </FieldGroup>
          </div>

          {feedback && (
            <div className="px-4 pb-4">
              <Alert variant={feedback.kind === 'error' ? 'destructive' : 'default'}>
                {feedback.kind === 'error' ? <CircleAlertIcon /> : <CheckCircle2Icon />}
                <AlertTitle>
                  {t(feedback.kind === 'error' ? 'settings.ai.connectionFailed' : 'settings.ai.ready')}
                </AlertTitle>
                <AlertDescription>{feedback.message}</AlertDescription>
              </Alert>
            </div>
          )}

          <div className="flex flex-col">
            <Separator />
            <DialogFooter className="p-4 sm:justify-between">
              <div className="flex flex-wrap gap-2">
                {onDelete && (
                  <Button type="button" variant="destructiveOutline" onClick={onDelete}>
                    {t('settings.ai.deleteProvider')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!canTest || busy}
                  onClick={() => void handleLoadModels()}
                >
                  {busy && <Spinner data-icon="inline-start" />}
                  {t('settings.ai.verifyConnection')}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={!canSave || busy}>
                  {t('common.save')}
                </Button>
              </div>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

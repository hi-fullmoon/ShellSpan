import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import { invokeListAiModels } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { AI_PROVIDER_PRESETS, useAiSettingsStore } from '@/stores/aiSettingsStore';
import type { AiProviderKind, AiProviderPreset } from '@/types/ai';
import {
  DeepSeekBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
} from './provider-brand-icons';

const PRESET_DESCRIPTION_KEYS: Record<AiProviderPreset, LocaleKey> = {
  ollama: 'settings.ai.preset.ollama',
  openai: 'settings.ai.preset.openai',
  deepseek: 'settings.ai.preset.deepseek',
  minimax: 'settings.ai.preset.minimax',
  kimi: 'settings.ai.preset.kimi',
  custom: 'settings.ai.preset.custom',
};

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

const protocolOutputDefaults = (kind: AiProviderKind) => {
  if (kind === 'ollama') {
    return { kind, requiresApiKey: false, structuredOutput: 'jsonSchema' as const };
  }
  if (kind === 'openAi') {
    return { kind, requiresApiKey: true, structuredOutput: 'jsonSchema' as const };
  }
  return { kind, requiresApiKey: true, structuredOutput: 'prompt' as const };
};

export const AiSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const addProvider = useAiSettingsStore((state) => state.addProvider);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const contextLines = useAiSettingsStore((state) => state.contextLines);
  const setContextLines = useAiSettingsStore((state) => state.setContextLines);
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProviderId);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );

  useEffect(() => {
    if (selectedProvider && selectedProvider.id !== selectedProviderId) {
      setSelectedProviderId(selectedProvider.id);
    }
  }, [selectedProvider, selectedProviderId]);

  useEffect(() => {
    setModels([]);
    setError(undefined);
    setSuccess(undefined);
  }, [selectedProvider?.id]);

  if (!selectedProvider) return null;

  const hasApiKey = Boolean(selectedProvider.apiKey?.trim());
  const SelectedIcon = PRESET_ICONS[selectedProvider.preset];

  const handleAddProvider = (preset: AiProviderPreset): void => {
    const id = addProvider(preset);
    setSelectedProviderId(id);
    setAddOpen(false);
  };

  const handleDeleteProvider = (): void => {
    setBusy(true);
    setError(undefined);
    removeProvider(selectedProvider.id);
    const state = useAiSettingsStore.getState();
    setSelectedProviderId(state.defaultProviderId);
    setDeleteOpen(false);
    setBusy(false);
  };

  const handleTest = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const found = await invokeListAiModels(
        useAiSettingsStore.getState().getProviderConfig(selectedProvider.id),
      );
      setModels(found);
      setSuccess(t('settings.ai.connectionSuccess', { count: found.length }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="@container flex flex-col gap-4 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('settings.ai.title')}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.ai.description')}</p>
      </div>

      <div className="grid min-w-0 gap-4 @min-[44rem]:grid-cols-[15rem_minmax(0,1fr)]">
        <Card size="sm" className="min-w-0">
          <CardHeader className="border-b">
            <CardTitle>{t('settings.ai.providers')}</CardTitle>
            <CardDescription>{t('settings.ai.providersHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {providers.map((provider) => {
              const ProviderIcon = PRESET_ICONS[provider.preset];
              const selected = provider.id === selectedProvider.id;
              return (
                <Button
                  key={provider.id}
                  variant="ghost"
                  className={cn(
                    'h-auto w-full justify-start px-2 py-2 text-left',
                    selected && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => setSelectedProviderId(provider.id)}
                  disabled={busy}
                  aria-pressed={selected}
                >
                  <ProviderIcon data-icon="inline-start" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{provider.name}</span>
                    <span className="block truncate text-[11px] font-normal text-muted-foreground">
                      {provider.model || t('ai.modelMissing')}
                    </span>
                  </span>
                  {provider.id === defaultProviderId && (
                    <Badge variant="secondary">{t('settings.ai.default')}</Badge>
                  )}
                </Button>
              );
            })}
          </CardContent>
          <CardFooter>
            <Button variant="outline" size="sm" className="w-full" onClick={() => setAddOpen(true)} disabled={busy}>
              <PlusIcon data-icon="inline-start" />
              {t('settings.ai.addProvider')}
            </Button>
          </CardFooter>
        </Card>

        <div className="flex min-w-0 flex-col gap-3">
          <Card size="sm" className="min-w-0">
            <CardHeader className="border-b">
              <div className="flex min-w-0 items-center gap-2">
                <SelectedIcon />
                <CardTitle className="truncate">{selectedProvider.name}</CardTitle>
                <Badge variant="outline">
                  {selectedProvider.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                </Badge>
                {selectedProvider.id === defaultProviderId && (
                  <Badge variant="secondary">{t('settings.ai.default')}</Badge>
                )}
              </div>
              <CardDescription>{t(PRESET_DESCRIPTION_KEYS[selectedProvider.preset])}</CardDescription>
              {selectedProvider.id !== defaultProviderId && (
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setDefaultProvider(selectedProvider.id)} disabled={busy}>
                    <CheckCircle2Icon data-icon="inline-start" />
                    {t('settings.ai.setDefault')}
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <div className="grid gap-4 @min-[36rem]:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="ai-provider-name">{t('settings.ai.providerName')}</FieldLabel>
                    <Input
                      id="ai-provider-name"
                      value={selectedProvider.name}
                      onChange={(event) => updateProvider(selectedProvider.id, { name: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('settings.ai.protocol')}</FieldLabel>
                    <Select
                      value={selectedProvider.kind}
                      onValueChange={(value) => {
                        if (value) updateProvider(selectedProvider.id, protocolOutputDefaults(value as AiProviderKind));
                      }}
                    >
                      <SelectTrigger aria-label={t('settings.ai.protocol')}>
                        <SelectValue>{t(PROTOCOL_LABEL_KEYS[selectedProvider.kind])}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="ollama">{t('settings.ai.protocol.ollama')}</SelectItem>
                          <SelectItem value="openAi">{t('settings.ai.protocol.openAi')}</SelectItem>
                          <SelectItem value="openAiCompatible">{t('settings.ai.protocol.openAiCompatible')}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>{t('settings.ai.protocolHint')}</FieldDescription>
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="ai-base-url">{t('settings.ai.baseUrl')}</FieldLabel>
                  <Input
                    id="ai-base-url"
                    value={selectedProvider.baseUrl}
                    onChange={(event) => updateProvider(selectedProvider.id, { baseUrl: event.target.value })}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="ai-model">{t('settings.ai.model')}</FieldLabel>
                  <Combobox
                    items={models}
                    value={selectedProvider.model}
                    inputValue={selectedProvider.model}
                    onValueChange={(model) => {
                      if (model) updateProvider(selectedProvider.id, { model });
                    }}
                    onInputValueChange={(model) => updateProvider(selectedProvider.id, { model })}
                  >
                    <ComboboxInput
                      id="ai-model"
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
                  <FieldDescription>{t('settings.ai.modelHint')}</FieldDescription>
                </Field>

                {selectedProvider.kind === 'openAiCompatible' && (
                  <>
                    <Separator />
                    <Field className="flex-row items-center gap-3">
                      <div className="flex-1">
                        <FieldLabel htmlFor="ai-requires-key">{t('settings.ai.authRequired')}</FieldLabel>
                        <FieldDescription>{t('settings.ai.authRequiredHint')}</FieldDescription>
                      </div>
                      <Switch
                        id="ai-requires-key"
                        checked={selectedProvider.requiresApiKey}
                        onCheckedChange={(checked) => updateProvider(selectedProvider.id, { requiresApiKey: checked })}
                      />
                    </Field>
                  </>
                )}

                {selectedProvider.requiresApiKey && (
                  <Field>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="ai-api-key">{t('settings.ai.apiKey')}</FieldLabel>
                      <Badge variant={hasApiKey ? 'secondary' : 'outline'}>
                        {hasApiKey ? t('settings.ai.keyStored') : t('settings.ai.keyMissing')}
                      </Badge>
                    </div>
                    <Input
                      id="ai-api-key"
                      type="password"
                      value={selectedProvider.apiKey ?? ''}
                      onChange={(event) => updateProvider(selectedProvider.id, { apiKey: event.target.value })}
                      placeholder="sk-..."
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <FieldDescription>{t('settings.ai.keyHint')}</FieldDescription>
                  </Field>
                )}
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={busy || providers.length <= 1}
              >
                <Trash2Icon data-icon="inline-start" />
                {t('settings.ai.deleteProvider')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={busy || !selectedProvider.baseUrl.trim()}
              >
                {busy ? <Spinner /> : <RefreshCwIcon data-icon="inline-start" />}
                {t('settings.ai.testConnection')}
              </Button>
            </CardFooter>
          </Card>

          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>{t('settings.ai.provider')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>{t('settings.ai.ready')}</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t('settings.ai.contextLines')}</CardTitle>
          <CardDescription>{t('settings.ai.contextHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={String(contextLines)} onValueChange={(value) => setContextLines(Number(value))}>
            <SelectTrigger aria-label={t('settings.ai.contextLines')} className="max-w-xs">
              <SelectValue>{t('settings.ai.contextLinesValue', { count: contextLines })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[50, 100, 200, 500].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {t('settings.ai.contextLinesValue', { count })}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.ai.addProviderTitle')}</DialogTitle>
            <DialogDescription>{t('settings.ai.addProviderDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            {AI_PROVIDER_PRESETS.map((preset) => {
              const PresetIcon = PRESET_ICONS[preset.preset];
              return (
                <Button
                  key={preset.preset}
                  variant="outline"
                  className="h-auto min-w-0 items-start justify-start whitespace-normal px-3 py-3 text-left"
                  onClick={() => handleAddProvider(preset.preset)}
                >
                  <PresetIcon data-icon="inline-start" />
                  <span className="min-w-0 text-left">
                    <span className="block truncate">{preset.name}</span>
                    <span className="block break-words text-xs leading-snug font-normal text-muted-foreground">
                      {t(PRESET_DESCRIPTION_KEYS[preset.preset])}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings.ai.deleteProviderTitle', { name: selectedProvider.name })}
        description={t('settings.ai.deleteProviderDescription')}
        onConfirm={handleDeleteProvider}
      />
    </div>
  );
};

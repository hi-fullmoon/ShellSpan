import React, { useEffect, useMemo, useState } from 'react';
import {
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  HistoryIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  invokeAgentRolloutPolicy,
  invokeListAiModels,
  invokeSetAgentEnabled,
  isTauriRuntime,
} from '@/lib/tauri';
import {
  clearAgentConversationData,
  flushAgentSessionPersistence,
} from '@/lib/agent-sessions';
import { agentUiController } from '@/lib/agent-ui-controller';
import { deletePersistedAiConversations } from '@/lib/ai-sessions';
import {
  effectiveReasoningEffort,
  isAiReasoningEffort,
  reasoningEffortOptions,
} from '@/lib/ai-reasoning';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentRolloutPolicy } from '@/types/agent';
import type { AiProviderKind, AiProviderPreset, AiReasoningEffort } from '@/types/ai';
import {
  DeepSeekBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
} from './provider-brand-icons';
import { ProviderSetupDialog } from './provider-setup-dialog';

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

const REASONING_EFFORT_LABEL_KEYS: Record<AiReasoningEffort, LocaleKey> = {
  low: 'ai.reasoningEffort.low',
  high: 'ai.reasoningEffort.high',
  max: 'ai.reasoningEffort.max',
};

const protocolDefaults = (kind: AiProviderKind) => {
  if (kind === 'ollama') {
    return { kind, requiresApiKey: false };
  }
  if (kind === 'openAi') {
    return { kind, requiresApiKey: true };
  }
  return { kind, requiresApiKey: true };
};

interface AiSettingsSectionProps {
  embedded?: boolean;
}

export const AiSettingsSection: React.FC<AiSettingsSectionProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const contextLines = useAiSettingsStore((state) => state.contextLines);
  const setContextLines = useAiSettingsStore((state) => state.setContextLines);
  const agentEnabled = useAiSettingsStore((state) => state.agentEnabled);
  const setAgentEnabled = useAiSettingsStore((state) => state.setAgentEnabled);
  const activeAgentRequestId = useAgentStore((state) => state.activeRequestId);
  const conversations = useAiStore((state) => state.conversations);
  const activeWorkbenchConversationId = useAiStore((state) => (
    state.activeWorkbenchConversationId
  ));
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const persistenceStatus = useAiSettingsStore((state) => state.persistenceStatus);
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProviderId);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [agentPolicy, setAgentPolicy] = useState<AgentRolloutPolicy>();
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const [clearAgentOpen, setClearAgentOpen] = useState(false);
  const [historyActionBusy, setHistoryActionBusy] = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void invokeAgentRolloutPolicy()
      .then((policy) => {
        if (active) setAgentPolicy(policy);
      })
      .catch(() => {
        if (active) setAgentPolicy(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );
  const historicalConversations = useMemo(() => {
    const currentConversationIds = new Set(
      terminalSessions
        .map((session) => session.conversationId)
        .filter((id): id is string => Boolean(id)),
    );
    if (activeWorkbenchConversationId) {
      currentConversationIds.add(activeWorkbenchConversationId);
    }
    return conversations.filter((conversation) => !currentConversationIds.has(conversation.id));
  }, [activeWorkbenchConversationId, conversations, terminalSessions]);

  useEffect(() => {
    if (selectedProvider && selectedProvider.id !== selectedProviderId) {
      setSelectedProviderId(selectedProvider.id);
    }
  }, [selectedProvider, selectedProviderId]);

  useEffect(() => {
    setModels([]);
    setShowApiKey(false);
    setError(undefined);
    setSuccess(undefined);
  }, [selectedProvider?.id]);

  if (!selectedProvider) return null;

  const hasApiKey = Boolean(selectedProvider.apiKey?.trim());
  const keySavePending = persistenceStatus === 'pending' || persistenceStatus === 'saving';
  const keySaveFailed = persistenceStatus === 'error';
  const keyStatusKey: LocaleKey = keySaveFailed
    ? 'settings.ai.keySaveFailed'
    : keySavePending
      ? 'settings.ai.keySaving'
      : hasApiKey
        ? 'settings.ai.keyStored'
        : 'settings.ai.keyMissing';
  const SelectedIcon = PRESET_ICONS[selectedProvider.preset];
  const availableReasoningEfforts = reasoningEffortOptions(selectedProvider);
  const selectedReasoningEffort = effectiveReasoningEffort(selectedProvider);

  const handleDeleteProvider = (): void => {
    removeProvider(selectedProvider.id);
    const state = useAiSettingsStore.getState();
    setSelectedProviderId(state.defaultProviderId);
    setEditOpen(false);
    setDeleteOpen(false);
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

  const handleAgentEnabledChange = async (enabled: boolean): Promise<void> => {
    setAgentActionBusy(true);
    try {
      const effective = await invokeSetAgentEnabled(enabled);
      if (enabled && !effective) throw new Error('Agent rollout policy is disabled');
      useAgentPermissionStore.getState().resetAll();
      setAgentEnabled(enabled);
      if (enabled) {
        showSuccess(t('settings.ai.agent.enabled'));
        return;
      }
      await agentUiController.shutdown();
      await flushAgentSessionPersistence();
      showSuccess(t('settings.ai.agent.disabled'));
    } catch {
      showError(t(enabled ? 'settings.ai.agent.enableFailed' : 'settings.ai.agent.closeFailed'));
    } finally {
      setAgentActionBusy(false);
    }
  };

  const handleClearAgentSessions = async (): Promise<void> => {
    setAgentActionBusy(true);
    setClearAgentOpen(false);
    try {
      await agentUiController.shutdown();
      await flushAgentSessionPersistence();
      const conversations = useAiStore.getState().conversations;
      for (const conversation of conversations) {
        await clearAgentConversationData(conversation.id, conversation.startedAt);
      }
      useAgentPermissionStore.getState().resetAll();
      showSuccess(t('settings.ai.agent.sessionsCleared', { count: conversations.length }));
    } catch {
      showError(t('settings.ai.agent.clearFailed'));
    } finally {
      setAgentActionBusy(false);
    }
  };

  const handleClearConversationHistory = async (): Promise<void> => {
    const conversationsToDelete = historicalConversations;
    if (conversationsToDelete.length === 0) return;
    setHistoryActionBusy(true);
    setClearHistoryOpen(false);
    try {
      const count = await deletePersistedAiConversations(conversationsToDelete);
      const conversationIds = conversationsToDelete.map((conversation) => conversation.id);
      useAiStore.getState().removeConversations(conversationIds);
      for (const conversationId of conversationIds) {
        useAgentStore.getState().clearConversation(conversationId);
      }
      showSuccess(t('ai.history.deleted', { count }));
    } catch {
      showError(t('ai.history.deleteFailed'));
    } finally {
      setHistoryActionBusy(false);
    }
  };

  return (
    <div className={cn('@container flex flex-col gap-5', !embedded && 'px-4 py-4')}>
      {!embedded && (
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">{t('settings.ai.title')}</h2>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t('settings.ai.description')}</p>
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-4">
        <div className="contents">
          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ai-model-providers-heading">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h3 id="ai-model-providers-heading" className="text-sm font-semibold text-foreground">
                  {t('settings.ai.providers')}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t('settings.ai.providerCount', { count: providers.length })}
                </p>
              </div>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                {t('settings.ai.addProvider')}
              </Button>
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              {providers.map((provider) => {
                const ProviderIcon = PRESET_ICONS[provider.preset];
                const isDefault = provider.id === defaultProviderId;
                return (
                  <Card key={provider.id} size="sm" className="min-w-0">
                    <CardHeader className="gap-3 @min-[36rem]:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                          <ProviderIcon aria-hidden />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <CardTitle className="truncate">{provider.name}</CardTitle>
                            <Badge variant="outline">
                              {provider.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                            </Badge>
                            {isDefault && <Badge variant="secondary">{t('settings.ai.default')}</Badge>}
                          </div>
                          <CardDescription className="truncate">
                            {provider.model || t('ai.modelMissing')}
                          </CardDescription>
                        </div>
                      </div>
                      <CardAction className="flex items-center gap-2">
                        {!isDefault && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDefaultProvider(provider.id)}
                          >
                            {t('settings.ai.setDefault')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedProviderId(provider.id);
                            setEditOpen(true);
                          }}
                        >
                          {t('settings.ai.editProvider')}
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="text-xs leading-5 text-muted-foreground">
                      {t(PRESET_DESCRIPTION_KEYS[provider.preset])}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          <Card size="sm">
            <CardHeader className="border-b">
              <CardTitle>{t('settings.ai.contextLines')}</CardTitle>
              <CardDescription>{t('settings.ai.contextHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={String(contextLines)} onValueChange={(value) => setContextLines(Number(value))}>
                <SelectTrigger aria-label={t('settings.ai.contextLines')} className="w-full">
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
        </div>

        <div className="hidden" aria-hidden="true">
          <Card size="sm" className="min-w-0">
            <CardHeader className="border-b">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                  <SelectedIcon aria-hidden />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <CardTitle className="truncate">{selectedProvider.name}</CardTitle>
                    <Badge variant="outline">
                      {selectedProvider.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                    </Badge>
                    {selectedProvider.id === defaultProviderId && (
                      <Badge variant="secondary">{t('settings.ai.default')}</Badge>
                    )}
                  </div>
                  <CardDescription>{t(PRESET_DESCRIPTION_KEYS[selectedProvider.preset])}</CardDescription>
                </div>
              </div>
              {selectedProvider.id !== defaultProviderId && (
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setDefaultProvider(selectedProvider.id)} disabled={busy}>
                    {t('settings.ai.setDefault')}
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <section className="flex flex-col gap-4" aria-labelledby="ai-connection-heading">
                <div className="flex flex-col gap-0.5">
                  <h3 id="ai-connection-heading" className="text-sm font-medium text-foreground">
                    {t('settings.ai.connectionDetails')}
                  </h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('settings.ai.connectionDetailsHint')}
                  </p>
                </div>
                <FieldGroup>
                  <FieldGroup className="@min-[36rem]:grid @min-[36rem]:grid-cols-2">
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
                          if (value) updateProvider(selectedProvider.id, protocolDefaults(value as AiProviderKind));
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
                  </FieldGroup>

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

                  {selectedReasoningEffort && availableReasoningEfforts.length > 0 && (
                    <Field>
                      <FieldLabel>{t('settings.ai.reasoningEffort')}</FieldLabel>
                      <Select
                        value={selectedReasoningEffort}
                        onValueChange={(value) => {
                          if (isAiReasoningEffort(value)) {
                            updateProvider(selectedProvider.id, {
                              reasoningEffort: value,
                            });
                          }
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
              </section>

              <Separator />

              <section className="flex flex-col gap-4" aria-labelledby="ai-credentials-heading">
                <div className="flex flex-col gap-0.5">
                  <h3 id="ai-credentials-heading" className="text-sm font-medium text-foreground">
                    {t('settings.ai.credentials')}
                  </h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('settings.ai.credentialsHint')}
                  </p>
                </div>
                <FieldGroup>
                  {selectedProvider.kind === 'openAiCompatible' && (
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
                  )}

                  {selectedProvider.requiresApiKey && (
                    <Field data-invalid={keySaveFailed || undefined}>
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel htmlFor="ai-api-key">{t('settings.ai.apiKey')}</FieldLabel>
                        <Badge
                          variant={keySaveFailed ? 'destructive' : hasApiKey && !keySavePending ? 'secondary' : 'outline'}
                          aria-live="polite"
                        >
                          {t(keyStatusKey)}
                        </Badge>
                      </div>
                      <InputGroup>
                        <InputGroupInput
                          id="ai-api-key"
                          type={showApiKey ? 'text' : 'password'}
                          value={selectedProvider.apiKey ?? ''}
                          onChange={(event) => updateProvider(selectedProvider.id, { apiKey: event.target.value })}
                          aria-invalid={keySaveFailed || undefined}
                          placeholder="sk-..."
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            aria-label={t(showApiKey ? 'settings.ai.hideApiKey' : 'settings.ai.showApiKey')}
                            onClick={() => setShowApiKey((visible) => !visible)}
                          >
                            {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                      <FieldDescription>
                        {t(keySaveFailed ? 'settings.ai.keySaveFailedHint' : 'settings.ai.keyHint')}
                      </FieldDescription>
                    </Field>
                  )}

                  {!selectedProvider.requiresApiKey && (
                    <Alert>
                      <AlertTitle>{t('settings.ai.noApiKey')}</AlertTitle>
                      <AlertDescription>{t('settings.ai.noApiKeyHint')}</AlertDescription>
                    </Alert>
                  )}
                </FieldGroup>
              </section>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <Button
                variant="destructiveOutline"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                disabled={busy || providers.length <= 1}
              >
                {t('settings.ai.deleteProvider')}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleTest()}
                disabled={busy || !selectedProvider.baseUrl.trim()}
              >
                {busy && <Spinner data-icon="inline-start" />}
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
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <BotIcon />
            {t('settings.ai.agent.title')}
          </CardTitle>
          <CardDescription>{t('settings.ai.agent.description')}</CardDescription>
          <CardAction>
            <Badge variant={agentPolicy?.featureEnabled ? 'secondary' : 'outline'}>
              {agentPolicy
                ? t(`settings.ai.agent.stage.${agentPolicy.stage}` as LocaleKey)
                : t('settings.ai.agent.stage.checking')}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field
            className="flex-row items-center gap-3"
            data-disabled={!agentPolicy?.featureEnabled || agentActionBusy || undefined}
          >
            <div className="min-w-0 flex-1">
              <FieldLabel htmlFor="ai-agent-enabled">{t('settings.ai.agent.enable')}</FieldLabel>
              <FieldDescription>{t('settings.ai.agent.enableDescription')}</FieldDescription>
            </div>
            <Switch
              id="ai-agent-enabled"
              checked={agentEnabled && Boolean(agentPolicy?.featureEnabled)}
              disabled={!agentPolicy?.featureEnabled || agentActionBusy}
              onCheckedChange={(enabled) => void handleAgentEnabledChange(enabled)}
            />
          </Field>
          <Alert>
            <AlertTitle>{t('settings.ai.agent.permissionTitle')}</AlertTitle>
            <AlertDescription>{t('settings.ai.agent.permissionDescription')}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          <Button
            variant="destructiveOutline"
            size="sm"
            disabled={agentActionBusy}
            onClick={() => setClearAgentOpen(true)}
          >
            {agentActionBusy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
            {t('settings.ai.agent.clearSessions')}
          </Button>
        </CardFooter>
      </Card>

      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon />
            {t('ai.history')}
          </CardTitle>
          <CardDescription>
            {t('ai.history.description', { count: historicalConversations.length })}
          </CardDescription>
        </CardHeader>
        {historicalConversations.length === 0 && (
          <CardContent>
            <EmptyState
              className="min-h-32"
              icon={<HistoryIcon />}
              title={t('ai.history.empty')}
            />
          </CardContent>
        )}
        <CardFooter className="justify-end">
          <Button
            variant="destructiveOutline"
            size="sm"
            disabled={historicalConversations.length === 0 || historyActionBusy}
            onClick={() => setClearHistoryOpen(true)}
          >
            {historyActionBusy
              ? <Spinner data-icon="inline-start" />
              : <Trash2Icon data-icon="inline-start" />}
            {t('ai.history.deleteAll')}
          </Button>
        </CardFooter>
      </Card>

      <ProviderSetupDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(providerId) => setSelectedProviderId(providerId)}
      />

      <ProviderSetupDialog
        open={editOpen}
        provider={selectedProvider}
        onOpenChange={setEditOpen}
        onSaved={(providerId) => setSelectedProviderId(providerId)}
        onDelete={providers.length > 1
          ? () => {
              setEditOpen(false);
              setDeleteOpen(true);
            }
          : undefined}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings.ai.deleteProviderTitle', { name: selectedProvider.name })}
        description={t('settings.ai.deleteProviderDescription')}
        onConfirm={handleDeleteProvider}
        confirmVariant="destructiveOutline"
      />

      <ConfirmDeleteDialog
        open={clearHistoryOpen}
        onOpenChange={setClearHistoryOpen}
        title={t('ai.history.deleteAllConfirmTitle')}
        description={t('ai.history.deleteAllConfirmDescription', {
          count: historicalConversations.length,
        })}
        onConfirm={() => void handleClearConversationHistory()}
        confirmLabel={t('ai.history.deleteAll')}
        confirmVariant="destructiveOutline"
      />

      <AlertDialog open={clearAgentOpen} onOpenChange={setClearAgentOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.ai.agent.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {activeAgentRequestId
                ? t('settings.ai.agent.clearActiveDescription')
                : t('settings.ai.agent.clearDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructiveOutline"
              size="sm"
              onClick={() => void handleClearAgentSessions()}
            >
              {t('settings.ai.agent.clearConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import {
  BotIcon,
  HistoryIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
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
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  invokeAgentRolloutPolicy,
  invokeDeleteAiApiKey,
  invokeSetAgentEnabled,
  isTauriRuntime,
} from '@/lib/tauri';
import {
  clearAgentConversationData,
  flushAgentSessionPersistence,
} from '@/lib/agent-sessions';
import { agentUiController } from '@/lib/agent-ui-controller';
import { deletePersistedAiConversations } from '@/lib/ai-sessions';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAgentStore } from '@/stores/agentStore';
import { useAiStore } from '@/stores/aiStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentRolloutPolicy } from '@/types/agent';
import type { AiProviderPreset } from '@/types/ai';
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

interface AiSettingsSectionProps {
  embedded?: boolean;
}

export const AiSettingsSection: React.FC<AiSettingsSectionProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
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
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProviderId);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  if (!selectedProvider) return null;

  const handleDeleteProvider = async (): Promise<void> => {
    try {
      await invokeDeleteAiApiKey(selectedProvider.id);
      removeProvider(selectedProvider.id);
      const state = useAiSettingsStore.getState();
      setSelectedProviderId(state.defaultProviderId);
      setEditOpen(false);
      setDeleteOpen(false);
    } catch {
      showError(t('settings.ai.keyDeleteFailed'));
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
    <div className={cn('@container flex flex-col', embedded ? 'gap-4' : 'gap-5 px-4 py-4')}>
      {!embedded && (
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">{t('settings.ai.title')}</h2>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t('settings.ai.description')}</p>
        </div>
      )}

      <section aria-labelledby="ai-model-providers-heading">
        <Card size="sm" variant="outline" className="gap-0 py-0">
          <CardHeader className="border-b py-3">
            <CardTitle id="ai-model-providers-heading">{t('settings.ai.providers')}</CardTitle>
            <CardDescription>
              {t('settings.ai.providerCount', { count: providers.length })}
            </CardDescription>
            <CardAction>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                {t('settings.ai.addProvider')}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {providers.map((provider, index) => {
              const ProviderIcon = PRESET_ICONS[provider.preset];
              const isDefault = provider.id === defaultProviderId;
              return (
                <React.Fragment key={provider.id}>
                  {index > 0 && <Separator />}
                  <div
                    data-slot="ai-provider-row"
                    className="flex min-w-0 flex-col gap-3 px-4 py-3 @min-[36rem]:flex-row @min-[36rem]:items-center @min-[36rem]:justify-between"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                        <ProviderIcon aria-hidden />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{provider.name}</span>
                          <Badge variant="outline">
                            {provider.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                          </Badge>
                          {isDefault && <Badge variant="secondary">{t('settings.ai.default')}</Badge>}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {provider.model || t('ai.modelMissing')} · {t(PRESET_DESCRIPTION_KEYS[provider.preset])}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-2">
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
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            <Separator />
            <Field className="gap-2.5 px-4 py-3 @min-[34rem]:flex-row @min-[34rem]:items-center @min-[34rem]:justify-between">
              <div className="min-w-0 flex-1">
                <FieldLabel className="text-sm font-medium text-foreground">
                  {t('settings.ai.contextLines')}
                </FieldLabel>
                <FieldDescription className="leading-5">{t('settings.ai.contextHint')}</FieldDescription>
              </div>
              <Select value={String(contextLines)} onValueChange={(value) => setContextLines(Number(value))}>
                <SelectTrigger size="sm" aria-label={t('settings.ai.contextLines')} className="w-full @min-[34rem]:w-auto @min-[34rem]:min-w-36">
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
            </Field>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="terminal-agent-heading">
        <Card size="sm" variant="outline" className="gap-0 py-0">
          <CardHeader className="flex items-start gap-3 border-b py-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <BotIcon className="size-4" aria-hidden />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle id="terminal-agent-heading">{t('settings.ai.agent.title')}</CardTitle>
                <Badge variant={agentPolicy?.featureEnabled ? 'secondary' : 'outline'}>
                  {agentPolicy
                    ? t(`settings.ai.agent.stage.${agentPolicy.stage}` as LocaleKey)
                    : t('settings.ai.agent.stage.checking')}
                </Badge>
              </div>
              <CardDescription>{t('settings.ai.agent.description')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-0 px-0">
            <Field
              className="flex-row items-center gap-4 px-4 py-3.5"
              data-disabled={!agentPolicy?.featureEnabled || agentActionBusy || undefined}
            >
              <div className="min-w-0 flex-1">
                <FieldLabel className="text-sm font-medium text-foreground" htmlFor="ai-agent-enabled">
                  {t('settings.ai.agent.enable')}
                </FieldLabel>
                <FieldDescription className="leading-5">
                  {t('settings.ai.agent.enableDescription')}
                </FieldDescription>
              </div>
              <Switch
                id="ai-agent-enabled"
                checked={agentEnabled && Boolean(agentPolicy?.featureEnabled)}
                disabled={!agentPolicy?.featureEnabled || agentActionBusy}
                onCheckedChange={(enabled) => void handleAgentEnabledChange(enabled)}
              />
            </Field>
            <Separator />
            <div className="p-4">
              <Alert size="sm">
                <ShieldCheckIcon aria-hidden />
                <AlertTitle>{t('settings.ai.agent.permissionTitle')}</AlertTitle>
                <AlertDescription>{t('settings.ai.agent.permissionDescription')}</AlertDescription>
              </Alert>
            </div>
          </CardContent>
          <CardFooter className="flex-col items-stretch justify-between gap-3 px-4 py-3 @min-[34rem]:flex-row @min-[34rem]:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-xs font-medium text-foreground">{t('settings.ai.agent.localData')}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('settings.ai.agent.localDataDescription')}
              </p>
            </div>
            <Button
              className="w-full @min-[34rem]:w-auto"
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
      </section>

      <section aria-labelledby="conversation-history-heading">
        <Card size="sm" variant="outline" className="gap-0 py-0">
          <CardHeader className="flex flex-col gap-3 py-4 @min-[34rem]:flex-row @min-[34rem]:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <HistoryIcon className="size-4" aria-hidden />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <CardTitle id="conversation-history-heading">{t('ai.history')}</CardTitle>
                <CardDescription>
                  {t('ai.history.description', { count: historicalConversations.length })}
                </CardDescription>
              </div>
            </div>
            <div className="flex w-full shrink-0 items-center @min-[34rem]:w-auto">
              {historicalConversations.length === 0 ? (
                <Badge variant="outline">{t('ai.history.empty')}</Badge>
              ) : (
                <Button
                  className="w-full @min-[34rem]:w-auto"
                  variant="destructiveOutline"
                  size="sm"
                  disabled={historyActionBusy}
                  onClick={() => setClearHistoryOpen(true)}
                >
                  {historyActionBusy
                    ? <Spinner data-icon="inline-start" />
                    : <Trash2Icon data-icon="inline-start" />}
                  {t('ai.history.deleteAll')}
                </Button>
              )}
            </div>
          </CardHeader>
        </Card>
      </section>

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
        onConfirm={() => void handleDeleteProvider()}
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

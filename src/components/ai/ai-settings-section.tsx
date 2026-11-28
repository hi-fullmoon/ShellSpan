import React, { useEffect, useMemo, useState } from 'react';
import {
  ArchiveIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeCleanupSandboxWorkspaces,
  invokeLocalSandboxStatus,
  invokeSandboxStorageStats,
  isTauriRuntime,
  type LocalSandboxStatus,
  type SandboxStorageStats,
} from '@/lib/ipc/tauri';
import { listAllAgentSessionRecords } from '@/lib/ai/session-records';
import { modelDefinitionOf } from '@/lib/ai/provider-contract';
import type { AiBusyPreference } from '@/lib/ai/submission-policy';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { type AgentSandboxNetworkMode, useAiSettingsStore } from '@/stores/aiSettingsStore';
import { validateSandboxAllowlistInput } from '@/lib/terminal/sandbox-terminal';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import type { AiProviderPreset } from '@/types/ai';
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
import { ProviderSetupDialog } from './provider-setup-dialog';
import { AiSessionRecordsDialog } from './ai-session-records-dialog';
import { AiSkillsDialog } from './ai-skills-dialog';
import { SettingRow, SettingsGroup } from '@/components/workbench/settings-layout';

const PRESET_DESCRIPTION_KEYS: Record<AiProviderPreset, LocaleKey> = {
  ollama: 'settings.ai.preset.ollama',
  openai: 'settings.ai.preset.openai',
  anthropic: 'settings.ai.preset.anthropic',
  deepseek: 'settings.ai.preset.deepseek',
  minimax: 'settings.ai.preset.minimax',
  kimi: 'settings.ai.preset.kimi',
  qwen: 'settings.ai.preset.qwen',
  glm: 'settings.ai.preset.glm',
  openrouter: 'settings.ai.preset.openrouter',
  custom: 'settings.ai.preset.custom',
};

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

interface AiSettingsSectionProps {
  embedded?: boolean;
}

function normalizeProviderPreset(presetId: string): AiProviderPreset {
  return Object.prototype.hasOwnProperty.call(PRESET_DESCRIPTION_KEYS, presetId)
    ? presetId as AiProviderPreset
    : 'custom';
}

function formatSandboxBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export const AiSettingsSection: React.FC<AiSettingsSectionProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const browserProviders = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const contextLines = useAiSettingsStore((state) => state.contextLines);
  const setContextLines = useAiSettingsStore((state) => state.setContextLines);
  const agentBusyPreference = useAiSettingsStore((state) => state.agentBusyPreference);
  const setAgentBusyPreference = useAiSettingsStore((state) => state.setAgentBusyPreference);
  const busyPreferenceControlId = React.useId();
  const sandboxControlId = React.useId();
  const sandboxNetworkControlId = React.useId();
  const sandboxAllowlistControlId = React.useId();
  const vimAutoAttachControlId = React.useId();
  const preferencesReady = useAiSettingsStore((state) => state.initialized);
  const agentSandboxEnabled = useAiSettingsStore((state) => state.agentSandboxEnabled);
  const agentSandboxSaving = useAiSettingsStore((state) => state.agentSandboxSaving);
  const setAgentSandboxEnabled = useAiSettingsStore((state) => state.setAgentSandboxEnabled);
  const agentSandboxNetworkMode = useAiSettingsStore((state) => state.agentSandboxNetworkMode);
  const agentSandboxNetworkAllowlist = useAiSettingsStore((state) => state.agentSandboxNetworkAllowlist);
  const agentSandboxNetworkSaving = useAiSettingsStore((state) => state.agentSandboxNetworkSaving);
  const setAgentSandboxNetworkPolicy = useAiSettingsStore((state) => state.setAgentSandboxNetworkPolicy);
  const [allowlistDraft, setAllowlistDraft] = useState(() => agentSandboxNetworkAllowlist.join(', '));
  useEffect(() => {
    setAllowlistDraft(agentSandboxNetworkAllowlist.join(', '));
  }, [agentSandboxNetworkAllowlist]);
  const contextLineItems = useMemo(
    () => [50, 100, 200, 500].map((count) => ({
      value: String(count),
      label: t('settings.ai.contextLinesValue', { count }),
    })),
    [t],
  );
  const busyPreferenceItems = useMemo<{ value: AiBusyPreference; label: string }[]>(
    () => [
      { value: 'queue', label: t('ai.workspace.queue.action') },
      { value: 'steer', label: t('ai.workspace.steer.action') },
    ],
    [t],
  );
  const sandboxNetworkModeItems: { value: AgentSandboxNetworkMode; label: string }[] = [
    { value: 'blocked', label: t('settings.ai.agent.sandboxNetwork.blocked') },
    { value: 'devRegistries', label: t('settings.ai.agent.sandboxNetwork.devRegistries') },
    { value: 'customAllowlist', label: t('settings.ai.agent.sandboxNetwork.customAllowlist') },
  ];
  const allowlistValidation = React.useMemo(
    () => validateSandboxAllowlistInput(allowlistDraft),
    [allowlistDraft],
  );
  const handleSaveSandboxNetworkPolicy = async (
    mode: AgentSandboxNetworkMode,
    allowlist: string[],
  ): Promise<void> => {
    try {
      await setAgentSandboxNetworkPolicy(mode, allowlist);
      showSuccess(t('settings.ai.agent.sandboxNetworkSaved'));
    } catch {
      showError(t('settings.ai.agent.sandboxNetworkSaveFailed'));
    }
  };
  const handleSaveCustomAllowlist = (): void => {
    if (allowlistValidation.invalid.length > 0) return;
    void handleSaveSandboxNetworkPolicy('customAllowlist', allowlistValidation.valid);
  };
  const [localSandboxStatus, setLocalSandboxStatus] = React.useState<LocalSandboxStatus | null>(null);
  const [sandboxStorage, setSandboxStorage] = React.useState<SandboxStorageStats | null>(null);
  const [sandboxStorageLoading, setSandboxStorageLoading] = React.useState(false);
  const [cleanupSandboxOpen, setCleanupSandboxOpen] = React.useState(false);
  const [sandboxCleanupBusy, setSandboxCleanupBusy] = React.useState(false);
  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void invokeLocalSandboxStatus().then((status) => {
      if (!cancelled) setLocalSandboxStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const supportsLocalSandbox = localSandboxStatus?.supported === true;
  const supportsSandboxNetworkPolicy = supportsLocalSandbox && localSandboxStatus.kind === 'macNono';
  const loadSandboxStorage = React.useCallback(async () => {
    if (!isTauriRuntime()) return;
    setSandboxStorageLoading(true);
    try {
      const stats = await invokeSandboxStorageStats();
      setSandboxStorage(stats);
    } catch {
      setSandboxStorage(null);
    } finally {
      setSandboxStorageLoading(false);
    }
  }, []);
  React.useEffect(() => {
    if (!supportsLocalSandbox) {
      setSandboxStorage(null);
      return;
    }
    void loadSandboxStorage();
  }, [loadSandboxStorage, supportsLocalSandbox]);
  const handleCleanupSandboxStorage = async (): Promise<void> => {
    if (sandboxCleanupBusy) return;
    setSandboxCleanupBusy(true);
    try {
      const result = await invokeCleanupSandboxWorkspaces();
      if (result.failedCount > 0) {
        showError(t('settings.ai.agent.sandboxStorageCleanupPartial', {
          removed: result.removedCount,
          size: formatSandboxBytes(result.freedBytes),
          failed: result.failedCount,
        }));
      } else {
        showSuccess(t('settings.ai.agent.sandboxStorageCleanupSuccess', {
          count: result.removedCount,
          size: formatSandboxBytes(result.freedBytes),
        }));
      }
      await loadSandboxStorage();
    } catch {
      showError(t('settings.ai.agent.sandboxStorageCleanupFailed'));
    } finally {
      setSandboxCleanupBusy(false);
    }
  };
  const sandboxDescription = localSandboxStatus?.supported && localSandboxStatus.kind === 'macNono'
    ? t('settings.ai.agent.sandboxDescriptionMac')
    : localSandboxStatus?.supported && localSandboxStatus.kind === 'windowsAppContainer'
      ? t('settings.ai.agent.sandboxDescriptionWindows')
      : localSandboxStatus && !localSandboxStatus.supported
        ? t('settings.ai.agent.sandboxDescriptionRemoteOnly')
        : t('settings.ai.agent.sandboxDescription');
  const vimBridgeAutoAttach = useAiSettingsStore((state) => state.vimBridgeAutoAttach);
  const vimBridgeAutoAttachSaving = useAiSettingsStore((state) => state.vimBridgeAutoAttachSaving);
  const setVimBridgeAutoAttach = useAiSettingsStore((state) => state.setVimBridgeAutoAttach);
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProviderId);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const [clearAgentOpen, setClearAgentOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const routeSnapshot=useLlmRoutesStore(state=>state.snapshot);
  const modelsByRoute=useLlmRoutesStore(state=>state.modelsByRoute);
  const hydrateRoutes=useLlmRoutesStore(state=>state.hydrate);
  const saveRoutes=useLlmRoutesStore(state=>state.save);
  const nativeRouteMode=isTauriRuntime();
  useEffect(()=>{ if(nativeRouteMode&&!routeSnapshot) void hydrateRoutes(); },[nativeRouteMode,routeSnapshot,hydrateRoutes]);
  const providers = useMemo(() => routeSnapshot ? routeSnapshot.routes.map(route => {
    const resolved=modelsByRoute[route.id]?.find(model=>model.modelId===route.defaults?.modelId) ?? modelsByRoute[route.id]?.[0];
    return { id:route.id,name:route.displayName,preset:normalizeProviderPreset(route.presetId),
      kind:(route.adapterId==='responses'?'openAi':route.adapterId==='ollama'?'ollama':route.adapterId==='anthropic-messages'?'anthropicMessages':'openAiCompatible') as 'openAi'|'ollama'|'anthropicMessages'|'openAiCompatible',
      profile:resolved?.profile,baseUrl:route.baseUrl,model:resolved?.modelId ?? route.defaults?.modelId ?? '',reasoningEffort:route.defaults?.reasoningEffort,
      modelDefinition:resolved ? modelDefinitionOf(resolved):undefined,
      requiresApiKey:route.auth.kind==='keychain' };
  }) : nativeRouteMode ? [] : browserProviders, [routeSnapshot,modelsByRoute,browserProviders,nativeRouteMode]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );
  // In native mode providers stay empty until the route snapshot hydrates;
  // the empty state must not flash while that load is still in flight.
  const providersLoaded = !nativeRouteMode || routeSnapshot !== undefined;

  useEffect(() => {
    if (selectedProvider && selectedProvider.id !== selectedProviderId) {
      setSelectedProviderId(selectedProvider.id);
    }
  }, [selectedProvider, selectedProviderId]);

  const handleDeleteProvider = async (): Promise<void> => {
    if (!selectedProvider) return;
    try {
      if (routeSnapshot) {
        const routes=routeSnapshot.routes.filter(route=>route.id!==selectedProvider.id);
        const fallback=routeSnapshot.defaultSelection?.routeId===selectedProvider.id
          ? routes[0]?.defaults : routeSnapshot.defaultSelection;
        await saveRoutes(routes,fallback);
      } else if (!nativeRouteMode) {
        removeProvider(selectedProvider.id);
      } else throw new Error('ROUTE_STATE_NOT_LOADED');
      const state = useAiSettingsStore.getState();
      setSelectedProviderId(state.defaultProviderId);
      setEditOpen(false);
      setDeleteOpen(false);
    } catch {
      showError(t('settings.ai.keyDeleteFailed'));
    }
  };

  const handleClearAgentSessions = async (): Promise<void> => {
    setAgentActionBusy(true);
    setClearAgentOpen(false);
    try {
      const sessions = isTauriRuntime()
        ? await listAllAgentSessionRecords()
        : [];
      for (const session of sessions.filter((item) => !item.archived)) {
        if (!session.ended) {
          await invokeCancelAgentRuntime({ sessionId: session.header.sessionId });
        }
        await invokeArchiveAgentRuntimeSession({ sessionId: session.header.sessionId });
      }
      useAgentPermissionStore.getState().resetAll();
      showSuccess(t('settings.ai.agent.sessionsCleared', { count: sessions.length }));
    } catch {
      showError(t('settings.ai.agent.clearFailed'));
    } finally {
      setAgentActionBusy(false);
    }
  };

  return (
    <div className={cn('@container flex flex-col', embedded ? 'gap-7' : 'gap-6 px-4 py-4')}>
      {!embedded && (
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">{t('settings.ai.title')}</h2>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t('settings.ai.description')}</p>
        </div>
      )}

      <SettingsGroup
        title={t('settings.ai.providers')}
        titleId="ai-model-providers-heading"
        action={(
          <Button variant="soft" size="sm" onClick={() => setAddOpen(true)}>
            {t('settings.ai.addProvider')}
          </Button>
        )}
      >
        {providers.map((provider) => {
          const ProviderIcon = PRESET_ICONS[provider.preset];
          const route = routeSnapshot?.routes.find(item => item.id === provider.id);
          const routeModels = modelsByRoute[provider.id] ?? [];
          const hasManyModels = routeModels.length > 3;
          const modelsExpanded = expandedModels[provider.id] ?? false;
          const visibleModels = hasManyModels && !modelsExpanded ? routeModels.slice(0, 3) : routeModels;
          const isDefault = routeSnapshot
            ? provider.id === routeSnapshot.defaultSelection?.routeId
            : provider.id === defaultProviderId;
          return (
            <Field
              key={provider.id}
              data-slot="ai-provider-row"
              className="min-h-14 gap-2 py-3.5 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-6"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                  <ProviderIcon aria-hidden />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.name}</span>
                    <Badge variant="outline">
                      {provider.kind === 'ollama' ? t('ai.local') : t('ai.cloud')}
                    </Badge>
                    {isDefault && <Badge variant="secondary">{t('settings.ai.default')}</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {(hasManyModels ? t('settings.ai.modelCount', { count: routeModels.length }) : route?.models
                      ? Object.keys(route.models).join(', ')
                      : provider.model) || t('ai.modelMissing')} · {t(PRESET_DESCRIPTION_KEYS[provider.preset])}
                  </p>
                  {route && (
                    <div id={`provider-models-${provider.id}`} className="flex min-w-0 flex-wrap items-center gap-1" aria-label={t('settings.ai.modelsLabel', { name: provider.name })}>
                      {visibleModels.map(model=>(
                        <Badge key={model.modelId} variant="secondary" className="max-w-full" title={model.displayName ? `${model.displayName} (${model.modelId})` : model.modelId}>
                          <span className="truncate">{hasManyModels ? model.displayName || model.modelId : model.displayName ? `${model.displayName} (${model.modelId})` : model.modelId}</span>
                        </Badge>
                      ))}
                      {hasManyModels && (
                        <Badge
                          render={<button type="button" />}
                          variant="secondary"
                          className="cursor-default"
                          aria-label={modelsExpanded ? t('settings.ai.collapseModels') : t('settings.ai.showMoreModels', { count: routeModels.length - 3 })}
                          title={modelsExpanded ? t('settings.ai.collapseModels') : t('settings.ai.showMoreModels', { count: routeModels.length - 3 })}
                          aria-expanded={modelsExpanded}
                          aria-controls={`provider-models-${provider.id}`}
                          onClick={() => setExpandedModels(current => ({ ...current, [provider.id]: !modelsExpanded }))}
                        >
                          {modelsExpanded ? t('settings.ai.collapseModels') : `${t('settings.ai.showMoreModels', { count: routeModels.length - 3 })}…`}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex min-h-8 w-full shrink-0 items-center gap-2 @min-[32rem]:w-auto @min-[32rem]:justify-end">
                {!isDefault && (
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => {
                      const route=routeSnapshot?.routes.find(item=>item.id===provider.id);
                      if(routeSnapshot && route?.defaults) void saveRoutes(routeSnapshot.routes,route.defaults);
                      else if (!nativeRouteMode) setDefaultProvider(provider.id);
                    }}
                  >
                    {t('settings.ai.setDefault')}
                  </Button>
                )}
                <Button
                  variant="soft"
                  size="sm"
                  onClick={() => {
                    setSelectedProviderId(provider.id);
                    setEditOpen(true);
                  }}
                >
                  {t('settings.ai.editProvider')}
                </Button>
              </div>
            </Field>
          );
        })}
        {providersLoaded && providers.length === 0 && (
          <EmptyState
            title={t('settings.ai.providersEmpty')}
            description={t('settings.ai.providersEmptyDescription')}
            className="py-6"
          />
        )}
        <SettingRow
          label={t('settings.ai.contextLines')}
          description={t('settings.ai.contextHint')}
        >
          <Select items={contextLineItems} value={String(contextLines)} onValueChange={(value) => { if (value) setContextLines(Number(value)); }}>
            <SelectTrigger variant="ghost" size="sm" aria-label={t('settings.ai.contextLines')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                {contextLineItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      {nativeRouteMode && (
        <SettingsGroup title={t('settings.ai.agent.title')}>
          <SettingRow
            controlId={busyPreferenceControlId}
            label={t('settings.ai.agent.busyPreference')}
            description={t('settings.ai.agent.busyPreferenceDescription')}
            descriptionId={`${busyPreferenceControlId}-description`}
          >
            <Select
              items={busyPreferenceItems}
              value={agentBusyPreference}
              onValueChange={(value) => {
                if (value === 'queue' || value === 'steer') setAgentBusyPreference(value);
              }}
            >
              <SelectTrigger
                id={busyPreferenceControlId}
                variant="ghost"
                size="sm"
                className="max-w-full"
                aria-label={t('settings.ai.agent.busyPreference')}
                aria-describedby={`${busyPreferenceControlId}-description`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {busyPreferenceItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            controlId={sandboxControlId}
            label={t('settings.ai.agent.sandbox')}
            description={sandboxDescription}
            descriptionId={`${sandboxControlId}-description`}
          >
            <Switch
              id={sandboxControlId}
              aria-label={t('settings.ai.agent.sandbox')}
              aria-describedby={`${sandboxControlId}-description`}
              checked={agentSandboxEnabled}
              disabled={!preferencesReady || agentSandboxSaving}
              onCheckedChange={(enabled) => {
                void setAgentSandboxEnabled(enabled).catch(() => showError(t('settings.ai.agent.sandboxSaveFailed')));
              }}
            />
          </SettingRow>
          {agentSandboxEnabled && supportsSandboxNetworkPolicy && (
            <SettingRow
              controlId={sandboxNetworkControlId}
              label={t('settings.ai.agent.sandboxNetwork')}
              description={t('settings.ai.agent.sandboxNetworkDescription')}
              descriptionId={`${sandboxNetworkControlId}-description`}
            >
              <Select
                items={sandboxNetworkModeItems}
                value={agentSandboxNetworkMode}
                disabled={!preferencesReady || agentSandboxNetworkSaving}
                onValueChange={(value) => {
                  if (!value) return;
                  const nextMode = value as AgentSandboxNetworkMode;
                  const nextAllowlist = nextMode === 'customAllowlist'
                    ? (allowlistValidation.invalid.length === 0 ? allowlistValidation.valid : agentSandboxNetworkAllowlist)
                    : agentSandboxNetworkAllowlist;
                  void handleSaveSandboxNetworkPolicy(nextMode, nextAllowlist);
                }}
              >
                <SelectTrigger
                  id={sandboxNetworkControlId}
                  variant="ghost"
                  size="sm"
                  className="max-w-full"
                  aria-label={t('settings.ai.agent.sandboxNetwork')}
                  aria-describedby={`${sandboxNetworkControlId}-description`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {sandboxNetworkModeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingRow>
          )}
          {agentSandboxEnabled && supportsSandboxNetworkPolicy && agentSandboxNetworkMode === 'customAllowlist' && (
            <SettingRow
              controlId={sandboxAllowlistControlId}
              label={t('settings.ai.agent.sandboxAllowlist')}
              description={t('settings.ai.agent.sandboxAllowlistDescription')}
              descriptionId={`${sandboxAllowlistControlId}-description`}
            >
              <div className="flex w-full flex-col gap-1.5 @min-[32rem]:w-auto">
                <div className="flex w-full items-center gap-2 @min-[32rem]:w-auto">
                  <Input
                    id={sandboxAllowlistControlId}
                    aria-label={t('settings.ai.agent.sandboxAllowlist')}
                    aria-describedby={allowlistValidation.invalid.length > 0
                      ? `${sandboxAllowlistControlId}-description ${sandboxAllowlistControlId}-error`
                      : `${sandboxAllowlistControlId}-description`}
                    aria-invalid={allowlistValidation.invalid.length > 0 || undefined}
                    className="h-8 min-w-0 flex-1 rounded-lg text-xs @min-[32rem]:w-56"
                    value={allowlistDraft}
                    placeholder={t('settings.ai.agent.sandboxAllowlistPlaceholder')}
                    disabled={!preferencesReady || agentSandboxNetworkSaving}
                    onChange={(event) => setAllowlistDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleSaveCustomAllowlist();
                      }
                    }}
                  />
                  <Button
                    variant="soft"
                    size="sm"
                    disabled={!preferencesReady || agentSandboxNetworkSaving || allowlistValidation.invalid.length > 0}
                    onClick={handleSaveCustomAllowlist}
                  >
                    {t('common.save')}
                  </Button>
                </div>
                {allowlistValidation.invalid.length > 0 && (
                  <p
                    id={`${sandboxAllowlistControlId}-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {t('settings.ai.agent.sandboxAllowlistInvalid', {
                      domains: allowlistValidation.invalid.join(', '),
                    })}
                  </p>
                )}
              </div>
            </SettingRow>
          )}
          {supportsLocalSandbox && (
            <SettingRow
              label={t('settings.ai.agent.sandboxStorage')}
              description={
                sandboxStorageLoading && !sandboxStorage
                  ? t('settings.ai.agent.sandboxStorageLoading')
                  : !sandboxStorage || sandboxStorage.totalCount === 0
                    ? t('settings.ai.agent.sandboxStorageEmpty')
                    : t('settings.ai.agent.sandboxStorageSummary', {
                        totalCount: sandboxStorage.totalCount,
                        totalSize: formatSandboxBytes(sandboxStorage.totalBytes),
                        reclaimableCount: sandboxStorage.reclaimableCount,
                        reclaimableSize: formatSandboxBytes(sandboxStorage.reclaimableBytes),
                      })
              }
            >
              <Button
                className="w-full @min-[32rem]:w-auto"
                variant="soft"
                size="sm"
                disabled={sandboxStorageLoading || sandboxCleanupBusy || !sandboxStorage || sandboxStorage.reclaimableCount === 0}
                onClick={() => setCleanupSandboxOpen(true)}
              >
                {t(sandboxCleanupBusy ? 'settings.ai.agent.sandboxStorageCleaning' : 'settings.ai.agent.sandboxStorageCleanup')}
              </Button>
            </SettingRow>
          )}
          <SettingRow
            controlId={vimAutoAttachControlId}
            label={t('ai.settings.vimBridgeAutoAttach.title')}
            description={t('ai.settings.vimBridgeAutoAttach.description')}
            descriptionId={`${vimAutoAttachControlId}-description`}
          >
            <Switch
              id={vimAutoAttachControlId}
              aria-label={t('ai.settings.vimBridgeAutoAttach.title')}
              aria-describedby={`${vimAutoAttachControlId}-description`}
              checked={vimBridgeAutoAttach}
              disabled={!preferencesReady || vimBridgeAutoAttachSaving}
              onCheckedChange={(enabled) => {
                void setVimBridgeAutoAttach(enabled).catch(() => showError(t('settings.ai.agent.sandboxSaveFailed')));
              }}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.ai.skills.title')}
            description={t('settings.ai.skills.description')}
          >
            <Button
              className="w-full @min-[32rem]:w-auto"
              variant="soft"
              size="sm"
              onClick={() => setSkillsOpen(true)}
            >
              {t('settings.ai.skills.manage')}
            </Button>
          </SettingRow>
        </SettingsGroup>
      )}

      <SettingsGroup
        title={t('settings.ai.records.title')}
        titleId="ai-conversation-records-heading"
      >
        <SettingRow
          label={t('settings.ai.records.localData')}
          description={t('settings.ai.records.description')}
        >
          <Button
            className="w-full @min-[32rem]:w-auto"
            variant="soft"
            size="sm"
            onClick={() => setRecordsOpen(true)}
          >
            {t('settings.ai.records.manage')}
          </Button>
        </SettingRow>
        <SettingRow
          label={t('settings.ai.agent.localData')}
          description={t('settings.ai.agent.localDataDescription')}
        >
          <Button
            className="w-full @min-[32rem]:w-auto"
            variant="destructiveSoft"
            size="sm"
            disabled={agentActionBusy}
            onClick={() => setClearAgentOpen(true)}
          >
            {t('settings.ai.agent.clearSessions')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      {recordsOpen && <AiSessionRecordsDialog onOpenChange={setRecordsOpen} />}
      {skillsOpen && <AiSkillsDialog onOpenChange={setSkillsOpen} />}

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

      <ConfirmationDialog
        textOnlyActions
        open={cleanupSandboxOpen}
        onOpenChange={setCleanupSandboxOpen}
        title={t('settings.ai.agent.sandboxStorageCleanupTitle')}
        description={t('settings.ai.agent.sandboxStorageCleanupDescription', {
          count: sandboxStorage?.reclaimableCount ?? 0,
          size: formatSandboxBytes(sandboxStorage?.reclaimableBytes ?? 0),
        })}
        confirmLabel={t('settings.ai.agent.sandboxStorageCleanupConfirm')}
        confirmVariant="warning"
        media={<Trash2Icon />}
        mediaVariant="warning"
        onConfirm={() => {
          setCleanupSandboxOpen(false);
          void handleCleanupSandboxStorage();
        }}
      />

      <ConfirmationDialog
        textOnlyActions
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings.ai.deleteProviderTitle', { name: selectedProvider?.name ?? '' })}
        description={t('settings.ai.deleteProviderDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
        media={<Trash2Icon />}
        mediaVariant="destructive"
        onConfirm={() => void handleDeleteProvider()}
        buttonSize="sm"
      />

      <ConfirmationDialog
        textOnlyActions
        open={clearAgentOpen}
        onOpenChange={setClearAgentOpen}
        title={t('settings.ai.agent.clearTitle')}
        description={t('settings.ai.agent.clearActiveDescription')}
        confirmLabel={t('settings.ai.agent.clearConfirm')}
        confirmVariant="warning"
        media={<ArchiveIcon />}
        mediaVariant="warning"
        buttonSize="sm"
        onConfirm={() => void handleClearAgentSessions()}
      />
    </div>
  );
};

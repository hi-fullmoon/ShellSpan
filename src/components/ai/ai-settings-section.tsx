import React, { useEffect, useMemo, useState } from 'react';
import {
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeConvertAiSessionV4,
  invokeListAiSessionMigrations,
  invokeListAgentRuntimeSessions,
  isTauriRuntime,
} from '@/lib/ipc/tauri';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import type { AiProviderPreset } from '@/types/ai';
import {
  DeepSeekBrandIcon,
  KimiBrandIcon,
  MiniMaxBrandIcon,
  OllamaBrandIcon,
  OpenAiBrandIcon,
} from './provider-brand-icons';
import { ProviderSetupDialog } from './provider-setup-dialog';
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
  custom: 'settings.ai.preset.custom',
};

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

interface AiSettingsSectionProps {
  embedded?: boolean;
}

export const AiSettingsSection: React.FC<AiSettingsSectionProps> = ({ embedded = false }) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const legacyProviders = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const removeProvider = useAiSettingsStore((state) => state.removeProvider);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const contextLines = useAiSettingsStore((state) => state.contextLines);
  const setContextLines = useAiSettingsStore((state) => state.setContextLines);
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProviderId);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const [clearAgentOpen, setClearAgentOpen] = useState(false);
  const [migrations,setMigrations]=useState<{sessionId:string;status:string}[]>([]);
  useEffect(()=>{ if(isTauriRuntime()) void invokeListAiSessionMigrations().then(setMigrations).catch(error=>setMigrations([{sessionId:'migration',status:String(error)}])); },[]);
  const routeSnapshot=useLlmRoutesStore(state=>state.snapshot);
  const modelsByRoute=useLlmRoutesStore(state=>state.modelsByRoute);
  const hydrateRoutes=useLlmRoutesStore(state=>state.hydrate);
  const saveRoutes=useLlmRoutesStore(state=>state.save);
  const nativeRouteMode=isTauriRuntime();
  useEffect(()=>{ if(nativeRouteMode&&!routeSnapshot) void hydrateRoutes(); },[nativeRouteMode,routeSnapshot,hydrateRoutes]);
  const providers = useMemo(() => routeSnapshot ? routeSnapshot.routes.map(route => {
    const resolved=modelsByRoute[route.id]?.find(model=>model.modelId===route.defaults?.modelId) ?? modelsByRoute[route.id]?.[0];
    return { id:route.id,name:route.displayName,preset:(route.presetId ?? 'custom') as AiProviderPreset,
      kind:(route.adapterId==='responses'?'openAi':route.adapterId==='ollama'?'ollama':route.adapterId==='anthropic-messages'?'anthropicMessages':'openAiCompatible') as 'openAi'|'ollama'|'anthropicMessages'|'openAiCompatible',
      profile:resolved?.profile,baseUrl:route.baseUrl,model:resolved?.modelId ?? route.defaults?.modelId ?? '',reasoningEffort:route.defaults?.reasoningEffort,
      modelDefinition:resolved ? {contextWindow:resolved.contextWindow,maxOutputTokens:resolved.maxOutputTokens,toolCalling:resolved.toolCalling,textInput:resolved.textInput,imageInput:resolved.imageInput,reasoning:resolved.reasoning,compat:resolved.compat,vision:resolved.vision}:undefined,
      requiresApiKey:route.auth.kind==='keychain',retryPolicy:route.retryPolicy };
  }) : nativeRouteMode ? [] : legacyProviders, [routeSnapshot,modelsByRoute,legacyProviders,nativeRouteMode]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );

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
        ? (await invokeListAgentRuntimeSessions({ limit: 512 })).sessions
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
    <div className={cn('@container flex flex-col', embedded ? 'gap-4' : 'gap-5 px-4 py-4')}>
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
          <Button size="xs" onClick={() => setAddOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            {t('settings.ai.addProvider')}
          </Button>
        )}
      >
        {providers.map((provider) => {
          const ProviderIcon = PRESET_ICONS[provider.preset];
          const isDefault = routeSnapshot
            ? provider.id === routeSnapshot.defaultSelection?.routeId
            : provider.id === defaultProviderId;
          return (
            <Field
              key={provider.id}
              data-slot="ai-provider-row"
              className="min-h-16 gap-2.5 px-4 py-3 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
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
                    {(routeSnapshot?.routes.find(route=>route.id===provider.id)?.models
                      ? Object.keys(routeSnapshot.routes.find(route=>route.id===provider.id)!.models!).join(', ')
                      : provider.model) || t('ai.modelMissing')} · {t(PRESET_DESCRIPTION_KEYS[provider.preset])}
                  </p>
                  {routeSnapshot?.routes.find(route=>route.id===provider.id) && (
                    <div className="flex flex-wrap gap-1" aria-label={`${provider.name} models`}>
                      {(modelsByRoute[provider.id] ?? []).map(model=>(
                        <Badge key={model.modelId} variant="secondary">
                          {model.modelId}
                          {Boolean(routeSnapshot.routes.find(route=>route.id===provider.id)?.models) && (modelsByRoute[provider.id]?.length ?? 0)>1 && <Button variant="ghost" size="icon-xs" aria-label={`Remove ${model.modelId}`} onClick={()=>{
                            const route=routeSnapshot.routes.find(item=>item.id===provider.id)!;
                            const models={...(route.models ?? {})}; delete models[model.modelId];
                            const fallback=Object.keys(models)[0];
                            const updated={...route,models,defaults:route.defaults?.modelId===model.modelId&&fallback?{routeId:route.id,modelId:fallback}:route.defaults};
                            const defaultSelection=routeSnapshot.defaultSelection?.routeId===route.id&&routeSnapshot.defaultSelection.modelId===model.modelId&&fallback?{routeId:route.id,modelId:fallback}:routeSnapshot.defaultSelection;
                            void saveRoutes(routeSnapshot.routes.map(item=>item.id===route.id?updated:item),defaultSelection).catch(error=>showError(String(error)));
                          }}><Trash2Icon /></Button>}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex min-h-8 w-full shrink-0 items-center gap-2 @min-[32rem]:w-auto @min-[32rem]:justify-end">
                {!isDefault && (
                  <Button
                    variant="outline"
                    size="xs"
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
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setSelectedProviderId(provider.id);
                    setAddingModel(true);
                    setEditOpen(true);
                  }}
                >
                  Add model
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setSelectedProviderId(provider.id);
                    setAddingModel(false);
                    setEditOpen(true);
                  }}
                >
                  {t('settings.ai.editProvider')}
                </Button>
              </div>
            </Field>
          );
        })}
        <SettingRow
          label={t('settings.ai.contextLines')}
          description={t('settings.ai.contextHint')}
        >
          <Select value={String(contextLines)} onValueChange={(value) => setContextLines(Number(value))}>
            <SelectTrigger size="sm" aria-label={t('settings.ai.contextLines')}>
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
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('settings.ai.agent.title')}
        titleId="terminal-agent-heading"
      >
        <SettingRow
          label={t('settings.ai.agent.localData')}
          description={t('settings.ai.agent.localDataDescription')}
        >
          <Button
            className="w-full @min-[32rem]:w-auto"
            variant="destructiveOutline"
            size="xs"
            disabled={agentActionBusy}
            onClick={() => setClearAgentOpen(true)}
          >
            {agentActionBusy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
            {t('settings.ai.agent.clearSessions')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      {migrations.length>0 && <SettingsGroup title="Conversation log migration" titleId="ai-log-migration-heading">
        {migrations.map(migration=><SettingRow key={migration.sessionId} label={migration.sessionId} description={migration.status}>
          {migration.status==='pending' && <Button size="xs" variant="outline" onClick={()=>void invokeConvertAiSessionV4(migration.sessionId).then(()=>setMigrations(items=>items.map(item=>item.sessionId===migration.sessionId?{...item,status:'converted'}:item))).catch(error=>setMigrations(items=>items.map(item=>item.sessionId===migration.sessionId?{...item,status:String(error)}:item)))}>Convert to v5</Button>}
        </SettingRow>)}
      </SettingsGroup>}

      <ProviderSetupDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(providerId) => setSelectedProviderId(providerId)}
      />

      <ProviderSetupDialog
        open={editOpen}
        provider={selectedProvider}
        addingModel={addingModel}
        onOpenChange={(open)=>{setEditOpen(open);if(!open)setAddingModel(false);}}
        onSaved={(providerId) => setSelectedProviderId(providerId)}
        onDelete={!addingModel && providers.length > 1
          ? () => {
              setEditOpen(false);
              setDeleteOpen(true);
            }
          : undefined}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings.ai.deleteProviderTitle', { name: selectedProvider?.name ?? '' })}
        description={t('settings.ai.deleteProviderDescription')}
        onConfirm={() => void handleDeleteProvider()}
        buttonSize="xs"
      />

      <ConfirmationDialog
        open={clearAgentOpen}
        onOpenChange={setClearAgentOpen}
        title={t('settings.ai.agent.clearTitle')}
        description={t('settings.ai.agent.clearActiveDescription')}
        confirmLabel={t('settings.ai.agent.clearConfirm')}
        confirmVariant="destructive"
        buttonSize="xs"
        onConfirm={() => void handleClearAgentSessions()}
      />
    </div>
  );
};

import { useEffect, useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { invokeResolveAiSelection, isTauriRuntime } from '@/lib/ipc/tauri';
import { useResolvedModel } from '@/lib/ai/provider-contract';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/hooks/useI18n';
import {
  effectiveReasoningEffort,
  reasoningEffortOptions,
} from '@/lib/ai/ai-reasoning';
import type { LocaleKey } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import type { AiProviderConfig, AiProviderProfile, AiProviderPreset, AiReasoningOption } from '@/types/ai';

type ModelMenuPane = 'root' | 'model' | 'reasoning';

const REASONING_LABEL_KEYS: Record<string, LocaleKey> = {
  off: 'ai.reasoningEffort.off',
  on: 'ai.reasoningEffort.on',
  none: 'ai.reasoningEffort.off',
  minimal: 'ai.reasoningEffort.minimal',
  low: 'ai.reasoningEffort.low',
  medium: 'ai.reasoningEffort.medium',
  high: 'ai.reasoningEffort.high',
  xhigh: 'ai.reasoningEffort.xhigh',
  max: 'ai.reasoningEffort.max',
};

interface ProviderGroup {
  readonly id: string;
  readonly label: string;
  readonly providers: readonly AiProviderProfile[];
}

function groupProviders(providers: readonly AiProviderProfile[]): readonly ProviderGroup[] {
  const groups = new Map<string, AiProviderProfile[]>();
  for (const provider of providers) {
    if (!provider.model.trim()) continue;
    const key = provider.id;
    const group = groups.get(key) ?? [];
    group.push(provider);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    label: items[0]?.name ?? id,
    providers: items,
  }));
}

export interface AiComposerModelSelectorProps {
  readonly disabled?: boolean;
  readonly selection?: AiProviderConfig;
  readonly onSelect?: (provider: AiProviderConfig) => Promise<void>;
}

/** Provider-backed model and reasoning selector using the current persisted AI configuration. */
export function AiComposerModelSelector({
  disabled = false,
  selection,
  onSelect,
}: AiComposerModelSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const [open, setOpen] = useState(false);
  const routeSnapshot = useLlmRoutesStore((state) => state.snapshot);
  const hydrateRoutes = useLlmRoutesStore((state) => state.hydrate);
  const saveRoutes = useLlmRoutesStore((state) => state.save);
  useEffect(() => { if (!routeSnapshot && isTauriRuntime()) void hydrateRoutes(); }, [routeSnapshot, hydrateRoutes]);
  const modelsByRoute = useLlmRoutesStore((state) => state.modelsByRoute);
  const routeStatus = useLlmRoutesStore((state) => state.status);
  const routeError = useLlmRoutesStore((state) => state.error);
  const nativeRouteMode = isTauriRuntime();
  const routeProviders = useMemo(() => (routeSnapshot?.routes.flatMap(route =>
    (modelsByRoute[route.id] ?? []).map(resolved => ({
      model: resolved.modelId, modelDefinition: { contextWindow:resolved.contextWindow,maxOutputTokens:resolved.maxOutputTokens,toolCalling:resolved.toolCalling,textInput:resolved.textInput,imageInput:resolved.imageInput,reasoning:resolved.reasoning,compat:resolved.compat,vision:resolved.vision },
      id: route.id, routeRevision: route.revision, name: route.displayName, preset: (route.presetId ?? 'custom') as AiProviderPreset,
      kind: route.adapterId === 'responses' ? 'openAi' as const : route.adapterId === 'ollama' ? 'ollama' as const : 'openAiCompatible' as const,
      profile: resolved.profile, baseUrl: route.baseUrl,
      reasoningEffort: route.defaults?.modelId === resolved.modelId ? route.defaults.reasoningEffort : undefined,
      requiresApiKey: route.auth.kind === 'keychain', retryPolicy: route.retryPolicy,
    }))) ?? []), [routeSnapshot,modelsByRoute]);
  const availableProviders = routeSnapshot ? routeProviders : nativeRouteMode ? [] : providers;
  const [pane, setPane] = useState<ModelMenuPane>('root');
  const groups = useMemo(() => groupProviders(availableProviders), [availableProviders]);
  const defaultSelection=routeSnapshot?.defaultSelection;
  const defaultProvider = availableProviders.find((provider) => defaultSelection ? provider.id===defaultSelection.routeId && provider.model===defaultSelection.modelId : provider.id === defaultProviderId)
    ?? availableProviders[0];
  const current: AiProviderProfile | undefined = selection
    ? { name: selection.id, preset: 'custom' as const, ...availableProviders.find((item) => item.id === selection.id && item.model === selection.model), ...selection }
    : defaultProvider;
  const legacyResolution=useResolvedModel(!routeSnapshot ? current : undefined);
  const [validatedModel,setValidatedModel]=useState<import('@/lib/ai/provider-contract').ResolvedModel>();
  const [selectionError,setSelectionError]=useState<string>();
  useEffect(()=>{
    if(!routeSnapshot||!current){setValidatedModel(undefined);setSelectionError(undefined);return;}
    let cancelled=false; setValidatedModel(undefined); setSelectionError(undefined);
    void invokeResolveAiSelection({routeId:current.id,modelId:current.model,reasoningEffort:current.reasoningEffort},current.routeRevision ?? routeSnapshot.revision)
      .then(model=>{if(!cancelled)setValidatedModel(model);})
      .catch(error=>{if(!cancelled)setSelectionError(`INVALID_MODEL_SELECTION: ${String(error)}`);});
    return()=>{cancelled=true;};
  },[routeSnapshot,current?.id,current?.model,current?.reasoningEffort,current?.routeRevision]);
  const resolved = routeSnapshot ? validatedModel : legacyResolution.status==='ready'?legacyResolution.model:undefined;
  const reasoningOptions = routeSnapshot ? (resolved?.reasoning.map(option=>option.id) ?? []) : (current ? reasoningEffortOptions(current) : []);
  const candidateReasoning=!routeSnapshot&&current ? effectiveReasoningEffort(current) : undefined;
  const reasoning = current?.reasoningEffort ? (reasoningOptions.includes(current.reasoningEffort) ? current.reasoningEffort : undefined) : candidateReasoning;
  const modelLabel = current?.model.trim() || t('ai.modelMissing');
  const reasoningLabel = reasoning
    ? resolved?.reasoning.find(o => o.id === reasoning)?.displayName ?? (REASONING_LABEL_KEYS[reasoning] ? t(REASONING_LABEL_KEYS[reasoning]) : reasoning)
    : t('ai.reasoningEffort.default');
  const hasReasoning = reasoningOptions.length > 0;
  const triggerLabel = hasReasoning
    ? `${modelLabel} · ${reasoningLabel}`
    : modelLabel;

  const close = (): void => {
    setOpen(false);
    setPane('root');
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setPane('root');
      }}
    >
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="xs"
            className="ai-model-trigger"
            disabled={disabled || current === undefined || groups.length === 0}
            aria-label={t('ai.workspace.model.trigger', { selection: triggerLabel })}
            title={triggerLabel}
          />
        )}
      >
        <span className="ai-model-trigger-name">{modelLabel}</span>
        {hasReasoning && (
          <span className="ai-model-trigger-reasoning">{reasoningLabel}</span>
        )}
        <ChevronDownIcon
          data-icon="inline-end"
          data-open={open ? '' : undefined}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={8}
        align="end"
        className="ai-model-menu"
        aria-label={t('ai.workspace.model.menu')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pane === 'root') return;
          event.preventDefault();
          event.stopPropagation();
          setPane('root');
        }}
      >
        {(routeStatus==='error'||selectionError||(routeSnapshot && !resolved)) && <DropdownMenuGroup><DropdownMenuLabel role="status">{routeStatus==='error' ? routeError : selectionError ?? t('settings.ai.capabilitiesLoading')}</DropdownMenuLabel></DropdownMenuGroup>}
        {pane === 'root' && (
          <DropdownMenuGroup>
            <DropdownMenuItem
              closeOnClick={false}
              className="ai-model-menu-cell"
              onClick={() => setPane('model')}
            >
              <span>{t('ai.workspace.model.model')}</span>
              <span data-slot="ai-model-menu-value">{modelLabel}</span>
              <ChevronRightIcon />
            </DropdownMenuItem>
            {hasReasoning && (
              <DropdownMenuItem
                closeOnClick={false}
                className="ai-model-menu-cell"
                onClick={() => setPane('reasoning')}
              >
                <span>{t('ai.workspace.model.reasoning')}</span>
                <span data-slot="ai-model-menu-value">{reasoningLabel}</span>
                <ChevronRightIcon />
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        )}

        {pane === 'model' && groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={current ? `${current.id}\u0000${current.model}` : undefined}
              onValueChange={(value) => {
                const [routeId, modelId]=value.split('\u0000'); const selected=availableProviders.find(p=>p.id===routeId&&p.model===modelId);
                if (!selected) return;
                const {name:_n,preset:_p,...config}=selected;
                if (onSelect) void onSelect(config);
                else if (routeSnapshot) void saveRoutes(routeSnapshot.routes,{routeId,modelId,reasoningEffort:selected.reasoningEffort}).then(close);
                else if (!nativeRouteMode) setDefaultProvider(routeId);
                if (onSelect || !routeSnapshot) close();
              }}
            >
              {group.providers.map((provider) => (
                <DropdownMenuRadioItem
                  key={`${provider.id}:${provider.model}`}
                  value={`${provider.id}\u0000${provider.model}`}
                  closeOnClick
                  className="ai-model-menu-option"
                >
                  <span className="truncate">{provider.model}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}

        {pane === 'reasoning' && current && (
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={reasoning ?? 'provider-default'}
              onValueChange={(value) => {
                const patch = {
                  reasoningEffort: value === 'provider-default'
                    ? undefined
                    : value as AiReasoningOption,
                };
                if (onSelect) {
                  const { name: _name, preset: _preset, ...config } = current;
                  void onSelect({ ...config, ...patch });
                } else if (routeSnapshot) void saveRoutes(routeSnapshot.routes,{routeId:current.id,modelId:current.model,reasoningEffort:patch.reasoningEffort}).then(close);
                else if (!nativeRouteMode) updateProvider(current.id, patch);
                if (onSelect || !routeSnapshot) close();
              }}
            >
              <DropdownMenuRadioItem
                value="provider-default"
                closeOnClick
                className="ai-model-menu-option"
              >
                <span>{t('ai.reasoningEffort.default')}</span>
              </DropdownMenuRadioItem>
              {reasoningOptions.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  closeOnClick
                  className="ai-model-menu-option"
                >
                  <span>{resolved?.reasoning.find(o => o.id === option)?.displayName ?? option}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

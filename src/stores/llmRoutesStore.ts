import { create } from 'zustand';
import { invokeListAiRoutes, invokeListAiRouteModels, invokeSaveAiRoutes } from '@/lib/ipc/tauri';
import { modelDefinitionOf, type ResolvedModel } from '@/lib/ai/provider-contract';
import type { ModelSelection, ProviderRoute, RouteSnapshot } from '@/types/ai';
import type { AiProviderPreset, AiProviderProfile } from '@/types/ai';

export function routeProviderConfigs(snapshot: RouteSnapshot, modelsByRoute: Record<string, ResolvedModel[]>): AiProviderProfile[] {
  return snapshot.routes.flatMap(route => (modelsByRoute[route.id] ?? []).map(resolved => ({
    id: route.id, routeRevision: route.revision, name: route.displayName,
    preset: (route.presetId === 'generic' ? 'custom' : route.presetId) as AiProviderPreset,
    kind: route.adapterId === 'responses' ? 'openAi' as const
      : route.adapterId === 'ollama' ? 'ollama' as const
        : route.adapterId === 'anthropic-messages' ? 'anthropicMessages' as const
          : 'openAiCompatible' as const,
    profile: resolved.profile, baseUrl: route.baseUrl, model: resolved.modelId,
    modelDefinition: modelDefinitionOf(resolved),
    reasoningEffort: route.defaults?.modelId === resolved.modelId ? route.defaults.reasoningEffort : undefined,
    requiresApiKey: route.auth.kind === 'keychain',
  })));
}

interface LlmRoutesState {
  snapshot?: RouteSnapshot;
  status: 'idle'|'loading'|'ready'|'saving'|'error';
  error?: string;
  modelsByRoute: Record<string, ResolvedModel[]>;
  hydrate(): Promise<void>;
  save(routes: ProviderRoute[], defaultSelection: ModelSelection|undefined, secrets?: Record<string,string>): Promise<RouteSnapshot>;
}
const MAX_HYDRATE_REVISION_RETRIES = 3;
let hydrateInFlight: Promise<void> | null = null;
let hydrateGeneration = 0;

export const useLlmRoutesStore=create<LlmRoutesState>((set,get)=>({
  status:'idle', modelsByRoute:{},
  async hydrate(){
    if (hydrateInFlight) return hydrateInFlight;
    const generation = ++hydrateGeneration;
    const run = (async () => {
      set({status:'loading',error:undefined});
      try {
        for (let attempt = 0; attempt <= MAX_HYDRATE_REVISION_RETRIES; attempt += 1) {
          const snapshot=await invokeListAiRoutes();
          const responses=await Promise.all(snapshot.routes.map(async route=>[route.id,await invokeListAiRouteModels(route.id)] as const));
          if (responses.some(([,response])=>response.revision!==snapshot.revision)) {
            if (attempt < MAX_HYDRATE_REVISION_RETRIES) continue;
            throw new Error('ROUTE_REVISION_MISMATCH');
          }
          const entries=responses.map(([id,response])=>[id,response.models] as const);
          // Ignore a late response if a newer revision or generation has already been published.
          if (generation !== hydrateGeneration) return;
          if(get().snapshot && get().snapshot!.revision>snapshot.revision) return;
          set({snapshot,modelsByRoute:Object.fromEntries(entries),status:'ready'});
          return;
        }
      } catch(error){
        if (generation !== hydrateGeneration) return;
        set({status:'error',error:String(error)});
      }
    })().finally(() => {
      if (hydrateInFlight === run) hydrateInFlight = null;
    });
    hydrateInFlight = run;
    return run;
  },
  async save(routes,defaultSelection,secrets={}){
    const current=get().snapshot; if(!current) throw new Error('ROUTE_STATE_NOT_LOADED');
    const generation = ++hydrateGeneration;
    hydrateInFlight = null;
    set({status:'saving',error:undefined});
    try { const snapshot=await invokeSaveAiRoutes({routes,defaultSelection,expectedRevision:current.revision,secrets});
      const responses=await Promise.all(snapshot.routes.map(async route=>[route.id,await invokeListAiRouteModels(route.id)] as const));
      if(responses.some(([,response])=>response.revision!==snapshot.revision)) { await get().hydrate(); return get().snapshot ?? snapshot; }
      const entries=responses.map(([id,response])=>[id,response.models] as const);
      if (!get().snapshot || get().snapshot!.revision <= snapshot.revision) {
        set({snapshot,modelsByRoute:Object.fromEntries(entries),status:'ready'});
      }
      return get().snapshot ?? snapshot; }
    catch(error){
      if (generation === hydrateGeneration) set({status:'error',error:String(error)});
      throw error;
    }
  },
}));

import { create } from 'zustand';
import { invokeListAiRoutes, invokeListAiRouteModels, invokeSaveAiRoutes } from '@/lib/ipc/tauri';
import type { ResolvedModel } from '@/lib/ai/provider-contract';
import type { ModelSelection, ProviderRoute, RouteSnapshot } from '@/types/ai';
import type { AiProviderPreset, AiProviderProfile } from '@/types/ai';

export function routeProviderConfigs(snapshot: RouteSnapshot, modelsByRoute: Record<string, ResolvedModel[]>): AiProviderProfile[] {
  return snapshot.routes.flatMap(route => (modelsByRoute[route.id] ?? []).map(resolved => ({
    id: route.id, routeRevision: route.revision, name: route.displayName,
    preset: (route.presetId ?? 'custom') as AiProviderPreset,
    kind: route.adapterId === 'responses' ? 'openAi' as const
      : route.adapterId === 'ollama' ? 'ollama' as const
        : route.adapterId === 'anthropic-messages' ? 'anthropicMessages' as const
          : 'openAiCompatible' as const,
    profile: resolved.profile, baseUrl: route.baseUrl, model: resolved.modelId,
    modelDefinition: { contextWindow:resolved.contextWindow,maxOutputTokens:resolved.maxOutputTokens,toolCalling:resolved.toolCalling,textInput:resolved.textInput,imageInput:resolved.imageInput,reasoning:resolved.reasoning,compat:resolved.compat,vision:resolved.vision },
    reasoningEffort: route.defaults?.modelId === resolved.modelId ? route.defaults.reasoningEffort : undefined,
    requiresApiKey: route.auth.kind === 'keychain', retryPolicy: route.retryPolicy,
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
export const useLlmRoutesStore=create<LlmRoutesState>((set,get)=>({
  status:'idle', modelsByRoute:{},
  async hydrate(){ set({status:'loading',error:undefined}); try {
    const snapshot=await invokeListAiRoutes();
    const responses=await Promise.all(snapshot.routes.map(async route=>[route.id,await invokeListAiRouteModels(route.id)] as const));
    if(responses.some(([,response])=>response.revision!==snapshot.revision)) { await get().hydrate(); return; }
    const entries=responses.map(([id,response])=>[id,response.models] as const);
    // Ignore a late response if a newer revision has already been published.
    if(get().snapshot && get().snapshot!.revision>snapshot.revision) return;
    set({snapshot,modelsByRoute:Object.fromEntries(entries),status:'ready'});
  } catch(error){set({status:'error',error:String(error)});} },
  async save(routes,defaultSelection,secrets={}){
    const current=get().snapshot; if(!current) throw new Error('ROUTE_STATE_NOT_LOADED');
    set({status:'saving',error:undefined});
    try { const snapshot=await invokeSaveAiRoutes({routes,defaultSelection,expectedRevision:current.revision,secrets});
      const responses=await Promise.all(snapshot.routes.map(async route=>[route.id,await invokeListAiRouteModels(route.id)] as const));
      if(responses.some(([,response])=>response.revision!==snapshot.revision)) { await get().hydrate(); return snapshot; }
      const entries=responses.map(([id,response])=>[id,response.models] as const);
      set({snapshot,modelsByRoute:Object.fromEntries(entries),status:'ready'}); return snapshot; }
    catch(error){set({status:'error',error:String(error)}); throw error;}
  },
}));

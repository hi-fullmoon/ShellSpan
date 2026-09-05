import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@/lib/provider-contract';
import type { ProviderRoute, RouteSnapshot } from '@/types/ai';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const mocks=vi.hoisted(()=>({resolve:vi.fn()}));
vi.mock('@/lib/tauri',()=>({isTauriRuntime:()=>true,invokeResolveAiSelection:mocks.resolve}));

import { AiComposerModelSelector } from '../workspace/ai-composer-model-selector';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';

const compat={protocol:'openAiCompatible' as const,cumulativeStream:false,supportsStreamUsage:true,nativeReasoning:false,splitReasoning:false,replayReasoningContent:false,thinkTagFallback:false,parallelToolCalls:true,strictSchema:true,preservesReasoningAcrossTurns:false,reasoningEncoding:'effort' as const,clearThinking:false,defaultThinking:false};
const definition={contextWindow:8192,maxOutputTokens:1024,toolCalling:'supported' as const,textInput:'supported' as const,imageInput:'unsupported' as const,reasoning:[{id:'high',displayName:'High'}],compat};
const retry={maxAttempts:3,initialDelayMs:250,maxDelayMs:4000,maxServerDelayMs:30000,jitterRatio:0.2};
const route=(id:string,models:string[]):ProviderRoute=>({id,revision:1,displayName:'Same connection name',adapterId:'chat-completions',baseUrl:`https://${id}.example`,auth:{kind:'none'},replayDomainId:`domain-${id}`,models:Object.fromEntries(models.map(model=>[model,definition])),defaults:{routeId:id,modelId:models[0]},retryPolicy:retry,timeouts:{requestHeadersMs:30000,firstByteMs:30000,streamIdleMs:300000}});
const routes=[route('route-a',['a-one','a-two']),route('route-b',['b-one'])];
const snapshot:RouteSnapshot={schemaVersion:1,revision:8,routes,defaultSelection:{routeId:'route-a',modelId:'a-one'},migrationComplete:true,migrationIssues:[]};
const resolved=(routeId:string,modelId:string):ResolvedModel=>({catalogVersion:1,routeId,providerId:routeId,profile:'generic',kind:'openAiCompatible',modelId,source:'userDeclaration',capacityPolicy:'explicit',...definition});

describe('route-backed model selector',()=>{
  beforeEach(async()=>{
    useAppStore.setState({locale:'en-US'});
    await initI18n('en-US');
    mocks.resolve.mockImplementation(async(selection)=>resolved(selection.routeId,selection.modelId));
    useLlmRoutesStore.setState({snapshot,status:'ready',error:undefined,modelsByRoute:{'route-a':[resolved('route-a','a-one'),resolved('route-a','a-two')],'route-b':[resolved('route-b','b-one')]}});
  });
  afterEach(cleanup);

  it('groups the complete backend model list by route identity even when names match',async()=>{
    const user=userEvent.setup(); render(<AiComposerModelSelector/>);
    await screen.findByText('Default');
    await user.click(screen.getByRole('button',{name:/Model selection/}));
    await user.click(await screen.findByRole('menuitem',{name:/Model.*a-one/}));
    expect(screen.getAllByText('Same connection name')).toHaveLength(2);
    for(const model of ['a-one','a-two','b-one'])expect(screen.getByRole('menuitemradio',{name:model})).toBeVisible();
  });

  it('keeps a stale reasoning selection visible as invalid instead of falling back',async()=>{
    mocks.resolve.mockRejectedValue(new Error('UNSUPPORTED_REASONING_EFFORT'));
    const user=userEvent.setup(); render(<AiComposerModelSelector selection={{id:'route-a',routeRevision:1,kind:'openAiCompatible',baseUrl:'https://route-a.example',model:'a-one',reasoningEffort:'removed-level',requiresApiKey:false}}/>);
    await user.click(screen.getByRole('button',{name:/Model selection/}));
    expect(await screen.findByRole('status')).toHaveTextContent('INVALID_MODEL_SELECTION');
    expect(screen.queryByRole('menuitem',{name:/ai.workspace.model.reasoning/})).not.toBeInTheDocument();
  });
});

import { invokeListAiRoutes,invokeGetAiRouteApiKey,invokeSaveAiRoutes } from '@/lib/ipc/tauri';
import type { RouteSnapshot } from '@/types/ai';

function assert(value:unknown):asserts value {if(!value)throw new Error('P3_CREDENTIAL_SETUP_REJECTED');}
function request(url:string,options:RequestInit={}){return fetch(url,{...options,signal:AbortSignal.timeout(url.endsWith('/export')?65000:5000)});}
export async function provisionP3Credential():Promise<void>{
 const parameters=new URL(location.href).searchParams;
 const mode=parameters.get('nativeP3CredentialMode');
 const endpoint=`/__native-p3-credential/${parameters.get('token')}`;
 try{
  const response=await request(`${endpoint}/config`,{method:'POST'});assert(response.ok);
  const value:unknown=await response.json();assert(value&&typeof value==='object'&&'mode'in value&&value.mode===mode&&'origin'in value&&value.origin==='https://api.minimaxi.com'&&'runId'in value&&typeof value.runId==='string');
  const snapshot=await invokeListAiRoutes();
  if(mode==='verify-absence'){
   assert('expectedReference'in value&&typeof value.expectedReference==='string'&&/^llm-[a-f0-9-]{36}$/.test(value.expectedReference));
   const route=snapshot.routes.find(route=>route.auth.kind==='keychain'&&route.auth.reference===value.expectedReference);assert(route);
   let missing=false;try{await invokeGetAiRouteApiKey(route.id);}catch(error){missing=String(error).includes('MISSING_CREDENTIAL');}assert(missing);
   const confirmed=await request(`${endpoint}/absence`,{method:'POST',body:JSON.stringify({missing:true,reference:value.expectedReference})});assert(confirmed.ok);return;
  }
  if(mode==='source'){
   assert('routeId'in value&&typeof value.routeId==='string');const route=snapshot.routes.find(route=>route.id===value.routeId);
   assert(route&&new URL(route.baseUrl).origin===value.origin&&route.adapterId==='chat-completions'&&route.presetId==='minimax');
   const secret=await invokeGetAiRouteApiKey(route.id);assert(secret.length>0);
   const exported=await request(`${endpoint}/export`,{method:'POST',body:secret});assert(exported.ok);const receipt:unknown=await exported.json();
   assert(receipt&&typeof receipt==='object'&&'stored'in receipt&&receipt.stored===true);return;
  }
  assert(mode==='destination'&&snapshot.routes.length===0&&!snapshot.defaultSelection&&'routeDocument'in value&&value.routeDocument&&typeof value.routeDocument==='object'&&'routes'in value.routeDocument&&Array.isArray(value.routeDocument.routes));
  const document=value.routeDocument as RouteSnapshot;assert(document.routes.length===1&&document.defaultSelection?.routeId===document.routes[0].id);
  const route=document.routes[0];assert(new URL(route.baseUrl).origin===value.origin&&route.adapterId==='chat-completions'&&route.presetId==='minimax');
  const ready=await request(`${endpoint}/ready`,{method:'POST'});assert(ready.ok);
  const deadline=Date.now()+180000;let secret:string|undefined;
  while(secret===undefined){assert(Date.now()<deadline);const incoming=await request(`${endpoint}/take`,{method:'POST'});if(incoming.status===204){await new Promise(resolve=>setTimeout(resolve,50));continue;}assert(incoming.ok);const payload:unknown=await incoming.json();assert(payload&&typeof payload==='object'&&'secret'in payload&&typeof payload.secret==='string'&&payload.secret.length>0);secret=payload.secret;}
  const saved=await invokeSaveAiRoutes({routes:document.routes,defaultSelection:document.defaultSelection,expectedRevision:snapshot.revision,secrets:{[route.id]:secret}});
  const created=saved.routes.find(value=>value.id===route.id);assert(created?.auth.kind==='keychain'&&created.auth.reference!==('reference'in route.auth?route.auth.reference:undefined)&&/^llm-[a-f0-9-]{36}$/.test(created.auth.reference));
  const stored=await invokeGetAiRouteApiKey(route.id);assert(stored===secret);secret=undefined;
  const receipt=await request(`${endpoint}/receipt`,{method:'POST',body:JSON.stringify({runId:value.runId,reference:created.auth.reference,readbackMatches:true})});assert(receipt.ok);
 }catch{throw new Error('P3_CREDENTIAL_SETUP_FAILED');}
}

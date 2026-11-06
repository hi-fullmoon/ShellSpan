import {invokeListAiRoutes} from '@/lib/ipc/tauri';
declare const __PACKAGE_REPORT__: string;
async function start() {
 const response=await fetch(__PACKAGE_REPORT__+'/stage');
 if(!response.ok)throw new Error('Owned package stage unavailable');
 const value:unknown=await response.json();
 if(!value||typeof value!=='object'||!('stage'in value))throw new Error('Invalid package stage');
 if(value.stage==='ordinary'){
  const routes=await invokeListAiRoutes();
  if(routes.routes.length||routes.defaultSelection)throw new Error('Fresh package route store is not empty');
  await import('./native-input-package.native');
 }else if(value.stage==='preflight')await import('./native-model-preflight.native');
 else if(value.stage==='file-chain')await import('./native-file-chain.native');
 else if(value.stage==='semantics')await import('./native-semantics.native');
 else throw new Error('Unsupported package stage');
}
void start().catch((error:unknown)=>fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,error:error instanceof Error?error.message:'PACKAGE_STAGE_FAILED'})}));

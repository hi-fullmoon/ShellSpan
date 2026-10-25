import { invokeListAiRoutes } from '@/lib/ipc/tauri';

async function initialize() {
  const snapshot=await invokeListAiRoutes();
  if(snapshot.routes.length!==0 || snapshot.defaultSelection) throw new Error('Independent native initialization requires an empty route store');
}
void initialize().then(()=>({ok:true}), (error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));

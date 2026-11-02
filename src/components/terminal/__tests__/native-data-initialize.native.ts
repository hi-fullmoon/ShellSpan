import { invokeListAiRoutes,invokeStoreProfilePassword,invokeDeleteProfilePassword,invokeRetrieveProfilePassword } from '@/lib/ipc/tauri';
import { provisionP3Credential } from './native-input-p3-credential';

async function initialize() {
  const parameters=new URL(location.href).searchParams;
  if(parameters.get('nativeP3CredentialMode')){await provisionP3Credential();return;}
  const mode=parameters.get('nativeP2CredentialMode');
  if(mode){
    const response=await fetch(`/__native-p2-credential/${parameters.get('token')}`,{method:'POST'});
    if(!response.ok)throw new Error('Owned credential provisioning channel failed');
    const value:unknown=await response.json();
    if(!value||typeof value!=='object'||!('reference'in value)||typeof value.reference!=='string'||!/^native-p2-secret-[0-9a-f-]{36}$/.test(value.reference))throw new Error('Invalid owned credential reference');
    if(mode==='cleanup'){
      await invokeDeleteProfilePassword(value.reference);
      if(await invokeRetrieveProfilePassword(value.reference))throw new Error('Owned keychain cleanup did not complete');
      return;
    }
    if(mode!=='provision'||!('password'in value)||typeof value.password!=='string')throw new Error('Invalid credential provisioning request');
    if(await invokeRetrieveProfilePassword(value.reference))throw new Error('Refusing to replace an existing keychain entry');
    await invokeStoreProfilePassword(value.reference,value.password);
  }
  const snapshot=await invokeListAiRoutes();
  if(snapshot.routes.length!==0 || snapshot.defaultSelection) throw new Error('Independent native initialization requires an empty route store');
}
void initialize().then(()=>({ok:true}), (error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));

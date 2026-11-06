import { invokeListAiRoutes,invokeStoreProfilePassword,invokeDeleteProfilePassword,invokeRetrieveProfilePassword,invokeGetTerminalSubmissionRecovery } from '@/lib/ipc/tauri';
import { provisionP3Credential } from './native-input-p3-credential';
import { verifyNativeCredentialLifecycle } from './native-credential-lifecycle.native';
import { verifyNativeAiCredential } from './native-ai-credential.native';

async function initialize() {
  const parameters=new URL(location.href).searchParams;
  if(parameters.get('nativeAiCredentialMode')){await verifyNativeAiCredential();return;}
  if(parameters.get('nativeCredentialLifecycle')==='true'){await verifyNativeCredentialLifecycle();return;}
  const recoveryAgent=parameters.get('journalRecoveryAgent');
  if(recoveryAgent){
    if(parameters.get('nativeP3CredentialMode')||parameters.get('nativeP2CredentialMode'))throw new Error('Read-only recovery cannot provision credentials');
    const expectedError=parameters.get('journalRecoveryError');
    if(expectedError){
      const errors:string[]=[];
      for(let index=0;index<2;index++){
        try{await invokeGetTerminalSubmissionRecovery(recoveryAgent);throw new Error('Storage refusal unexpectedly returned records');}
        catch(error){const message=String(error);if(!message.includes(expectedError))throw error;errors.push(message);}
      }
      await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({
        progress:'Actual App recovery API refused unavailable or invalid initialized journal storage.',
        evidence:{kind:'actual-app-journal-storage-refusal',expectedError,errors,terminalCreated:false,modelRequests:0,
          scope:'Read-only recovery refusal only; no new source admission or complete native crash-cut claim.'}})});
      return;
    }
    const first=await invokeGetTerminalSubmissionRecovery(recoveryAgent);
    const second=await invokeGetTerminalSubmissionRecovery(recoveryAgent);
    const expectedCount=parameters.get('journalRecoveryEmpty')==='true'?0:1;
    if(first.length!==expectedCount||!first.every(record=>record.version===1&&record.noAutoReplay&&record.identity.agentSessionId===recoveryAgent)
      ||JSON.stringify(first)!==JSON.stringify(second))throw new Error('Actual startup recovery did not preserve the expected unresolved identity');
    document.body.textContent='Read persisted recovery facts; no terminal or Agent request created.';
    await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({
      progress:expectedCount===0?'Actual native startup returned no intent for the pre-persistence crash.':'Actual native startup restored the durable original call fence through the normal read-only API.',
      evidence:{kind:'actual-app-journal-recovery-readonly',records:first,repeatedQueryUnchanged:true,terminalCreated:false,modelRequests:0,
        expectedCount,scope:'Actual new App startup and repeated read-only recovery query; persisted identity or expected empty pre-persistence result, without source replay.'}})});
    return;
  }
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

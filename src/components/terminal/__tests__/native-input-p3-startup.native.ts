import {getCurrentWindow} from '@tauri-apps/api/window';
import {Terminal} from '@xterm/xterm';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {acceptP3PublisherOnce} from './native-input-p3-publisher';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function verify(){
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const parameters=new URL(location.href).searchParams;
 const host=document.createElement('div');host.style.cssText='width:100vw;height:100vh';document.body.append(host);
 const session=await invokeCreateLocalSession(100,30);useTerminalStore.getState().addSession(session);
 const controller=terminalRegistry.create(session.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(value=>value.sessionId===id)?.status??'connecting',()=>{},session.ptyInfo);
 let rawStartup='';const observe=controller.subscribeOutput(chunk=>{if(rawStartup.length<262144)rawStartup+=chunk.slice(0,262144-rawStartup.length);});
 let reviewRequested=false;
 try{
  controller.attach(host);await controller.whenOutputReady();controller.focus();
  const deadline=Date.now()+25000;let snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId);
  let diagnosticSent=false;
  while(!snapshot.session?.promptReady||snapshot.session.integrationState!=='ready'){
   if(parameters.get('nativeP3StartupDiagnostic')==='true'&&!diagnosticSent&&Date.now()>deadline-18000&&snapshot.session?.lease?.owner.kind==='user'&&!snapshot.session.inputObservation?.activeCommand){
    diagnosticSent=true;
    // A real, read-only ordinary user command in this exclusive no-model case.
    // It inspects only callback metadata/errors, never reads credentials or
    // invokes the native service to manufacture readiness.
    const command="$p3Reader=Get-Command PSConsoleHostReadLine; $p3Subscriptions=@(Get-EventSubscriber -SourceIdentifier PowerShell.OnIdle); $p3Assembly=[Microsoft.PowerShell.PSConsoleReadLine].Assembly; $p3Diagnostic=@{engine=$PSVersionTable.PSVersion.ToString();host=$Host.Name;modules=@(Get-Module PSReadLine|ForEach-Object {@{version=$_.Version.ToString();path=$_.Path}});assembly=$p3Assembly.Location;assemblySha256=(Get-FileHash $p3Assembly.Location -Algorithm SHA256).Hash;modulePath=$env:PSModulePath;readerModule=$p3Reader.ScriptBlock.Module.Name;readerClosureModule=$p3Reader.ScriptBlock.Module.SessionState.PSVariable.GetValue('NativeModule').Name; subscriptions=@($p3Subscriptions|ForEach-Object {@{id=$_.SubscriptionId; jobState=[string]$_.Action.State; errors=@($_.Action.Error|ForEach-Object {@{id=$_.FullyQualifiedErrorId; message=$_.Exception.Message}})}})}; [IO.File]::WriteAllText((Join-Path $env:SHELLSPAN_DATA_DIR 'native-callbacks.json'),($p3Diagnostic|ConvertTo-Json -Depth 8)); [Console]::WriteLine('P3-CALLBACK-'+'DIAGNOSTIC')\r";
    assert(await controller.writeUserInput(command),'Ordinary user startup diagnostics were blocked');
   }
   await acceptP3PublisherOnce(controller,parameters);
   assert(Date.now()<deadline,'Actual P3 startup did not reach native editor readiness');
   await new Promise(resolve=>setTimeout(resolve,25));snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId);
  }
  assert(snapshot.session.inputMode==='native-inline'&&isCurrentNativeEditorProfile(snapshot.session.nativePeerProfile,parameters.get('nativeP3')),'Actual startup selected a different or unverified editor');
  assert(snapshot.session.inputObservation&&!snapshot.session.inputObservation.activeCommand&&!snapshot.session.inputObservation.nativeRecoveryRequired,'Startup created an operation or recovery gate');
  if(parameters.get('nativeP3RequireJobs')==='true')assert(snapshot.session.integrationCapabilities.includes('nativeJobControl'),'Actual controlled startup did not advertise the native jobs required by this model case');
  assert(controller.terminal.getSelection===Terminal.prototype.getSelection&&controller.terminal.open===Terminal.prototype.open,'Startup installed a renderer/source override');
  const buffer=controller.terminal.buffer.normal;
  let userEdit:unknown;
  if(parameters.get('nativeP3StartupUserEdit')==='true'){
   const source="[Console]::WriteLine('STARTUP_USER_'+'TEXT')";
   assert(await controller.writeUserInput(source+'\r'),'Ordinary startup input was blocked');
   const end=Date.now()+10000;
   while(!Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true)?.trim()).includes('STARTUP_USER_TEXT')){
    assert(Date.now()<end,'Ordinary startup output did not produce one intact line');
    await new Promise(resolve=>setTimeout(resolve,15));
   }
   userEdit={source,inputApiCalls:1,observedExactOutputLine:true,scope:'One ordinary user command; no Agent submission or model call'};
  }
  const rendered=Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)??'').join('\n');
  const rendering={userAgent:navigator.userAgent,devicePixelRatio:window.devicePixelRatio,
   windowsPty:controller.terminal.options.windowsPty,unicodeVersion:controller.terminal.unicode.activeVersion,
   canvasElements:host.querySelectorAll('canvas').length,domRows:host.querySelectorAll('.xterm-rows').length,
   columns:controller.terminal.cols,rows:controller.terminal.rows};
  await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Actual native startup ready; no model or Agent command executed',evidence:{kind:'actual-native-p3-startup',snapshot,rendered,rendering,userEdit,publicApisUnmodified:true}})});
  if(parameters.get('nativeP3Review')==='true'){reviewRequested=true;const response=await fetch(`/__native-p3-review/${parameters.get('token')}`,{method:'POST'});assert(response.ok,'Actual native window review was not completed');}
 }catch(error){
  const buffer=controller.terminal.buffer.normal;
  const rendered=Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)??'').join('\n');
  await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Actual native startup failed before any model call',evidence:{kind:'actual-native-p3-startup',failed:true,snapshot:await invokeGetTerminalBrokerSnapshot(session.sessionId),rendered,rawStartup}})});
  if(parameters.get('nativeP3Review')==='true'&&!reviewRequested){await fetch(`/__native-p3-review/${parameters.get('token')}`,{method:'POST'}).catch(()=>{});}
  throw error;
 }finally{observe();terminalRegistry.dispose(session.sessionId);await invokeCloseSession(session.sessionId);host.remove();}
}
void verify().then(()=>({ok:true}),error=>({ok:false,error:error instanceof Error?error.message:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));

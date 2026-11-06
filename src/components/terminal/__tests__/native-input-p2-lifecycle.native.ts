import {getCurrentWindow} from '@tauri-apps/api/window';
import {nativeP2Password} from './native-input-p2-credential';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCreateSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,
  invokeCheckHostKey,invokeTrustHost} from '@/lib/ipc/tauri';
import type {SessionSummary} from '@/types';
import '@/styles/base.css';
import {verifyWindowsNativeLifecycle} from './native-input-windows-lifecycle';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+10000;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}}
function text(controller:ReturnType<typeof terminalRegistry.create>){const buffer=controller.terminal.buffer.normal;return Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)??'').join('\n');}
async function verify(){
  await initI18n('en-US');await getCurrentWindow().show();
  const parameters=new URL(location.href).searchParams;
  if(['powerShell7','windowsPowerShell'].includes(parameters.get('nativeP3')??'')){
    // One initial activation for the explicitly scheduled standalone case.
    // Subsequent focus changes are observed, never forcibly reclaimed.
    await getCurrentWindow().setFocus();
    return verifyWindowsNativeLifecycle(parameters);
  }
  const port=Number(parameters.get('nativeP2SshPort'));assert(port>1024,'Owned SSH fixture required');
  const stages:unknown[]=[];const sessions:string[]=[];
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  let controller:ReturnType<typeof terminalRegistry.create>|undefined;
  const raw:Record<string,string>={};
  const disposers:(()=>void)[]=[];
  const add=(session:SessionSummary)=>{sessions.push(session.sessionId);useTerminalStore.getState().addSession(session);};
  const ready=async()=>{assert(controller,'Registry controller missing');await controller.whenOutputReady();await until(()=>!terminalInputReadiness.isPreparing(controller!.sessionId)&&useTerminalStore.getState().sessions.find(value=>value.sessionId===controller!.sessionId)?.status==='connected','Actual reconnect guard/status did not become ready');};
  try{
    const first=await invokeCreateLocalSession(100,30);add(first);
    assert(first.ptyInfo?.inputMode==='native-inline'&&first.ptyInfo.nativeDisplayBinding,'Normal native startup not negotiated');
    controller=terminalRegistry.create(first.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(value=>value.sessionId===id)?.status??'connecting',()=>{},first.ptyInfo);
    controller.attach(host);await controller.whenOutputReady();controller.focus();
    const target=controller;
    disposers.push(target.subscribeOutput(chunk=>{raw[target.sessionId]=(raw[target.sessionId]??'')+chunk;}));
    const originals={selection:target.terminal.getSelection,open:target.terminal.open,getLine:Object.getPrototypeOf(target.terminal.buffer.normal).getLine};
    const assertPublic=()=>assert(target.terminal.getSelection===originals.selection&&target.terminal.open===originals.open&&target.terminal.buffer.normal.getLine===originals.getLine,'Native/raw rebind installed a renderer/selection/source override');
    // Real ordinary program output deliberately enters display mode and ends
    // with a partial OSC. It has no Agent operation, proof or execute authority.
    assert(await target.writeUserInput("printf '%s%s\\n' OLD_NATIVE_ OUTPUT; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ'; exec /bin/sleep 0.3\r"),'Initial real user command blocked');
    await until(()=>target.terminal.options.reflowCursorLine===true,'Real producer did not enter native display');
    await until(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===first.sessionId)?.status==='disconnected','Real native EOF missing');
    await until(()=>target.terminal.options.reflowCursorLine===false,'EOF did not drain/dispose native display');
    assert(text(target).includes('OLD_NATIVE_OUTPUT'),'Native EOF lost historical output');assertPublic();
    const second=await invokeCreateLocalSession(40,30,first.sessionId);add(second);
    terminalRegistry.rebindSession(first.sessionId,second.sessionId,second.ptyInfo);await ready();
    assert(await target.writeUserInput("printf '%s%s\\n' NEW_NATIVE_ TEXT\r"),'Native rebind user input blocked');
    await until(()=>text(target).includes('NEW_NATIVE_TEXT'),'Native startup ESC did not terminate the old parser tail');
    assert(text(target).includes('OLD_NATIVE_OUTPUT'),'Native-to-native erased history');assertPublic();
    stages.push({stage:'native-to-native',old:first.sessionId,new:second.sessionId,text:text(target),raw:{...raw}});
    // A real incomplete UTF-8 producer exits; the backend's streaming decoder
    // flushes its tail before registry disposal. No fake data event is injected.
    assert(await target.writeUserInput("printf '%s%s\\n' UTF8_ BEFORE; printf '\\342\\202'; exec /bin/sleep 0.3\r"),'UTF-8 EOF command blocked');
    await until(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===second.sessionId)?.status==='disconnected','UTF-8 producer did not exit');
    const key=await invokeCheckHostKey('127.0.0.1',port);assert(key.status==='match'||key.status==='notFound','Fixture host identity changed');if(key.status==='notFound'){assert(key.fingerprint,'Fixture fingerprint missing');await invokeTrustHost('127.0.0.1',port,key.fingerprint);}
    const ordinary=await invokeCreateSession({name:'Owned raw Bash boundary',host:'127.0.0.1',port,username:'nativeRaw',authMethod:'password',password:await nativeP2Password(),terminalCols:32,terminalRows:30,replacesSessionId:second.sessionId});add(ordinary);
    assert(ordinary.ptyInfo?.inputMode==='raw','Unverified actual shell did not initialize as raw');
    terminalRegistry.rebindSession(second.sessionId,ordinary.sessionId,ordinary.ptyInfo);await ready();
    assert(await target.writeUserInput("printf '%s%s\\n' RAW_NEW_ TEXT\r"),'Ordinary unsupported shell was not usable');
    await until(()=>text(target).includes('RAW_NEW_TEXT'),'Raw text was swallowed by a prior OSC/UTF-8 parser tail');
    assert(text(target).includes('OLD_NATIVE_OUTPUT')&&text(target).includes('NEW_NATIVE_TEXT')&&text(target).includes('UTF8_BEFORE'),'Raw rebind erased prior history');
    assert(target.inputMode==='raw'&&target.terminal.options.reflowCursorLine===false,'Raw reused native display state');assertPublic();
    const snapshot=(await invokeGetTerminalBrokerSnapshot(ordinary.sessionId)).session;
    assert(snapshot?.inputMode==='raw'&&snapshot.integrationState!=='ready'&&!snapshot.inputObservation?.activeCommand,'Untrusted display created an executable native operation');
    stages.push({stage:'native-to-raw',snapshot,text:text(target),raw:{...raw}});
    const final=await invokeCreateLocalSession(180,30,ordinary.sessionId);add(final);
    terminalRegistry.rebindSession(ordinary.sessionId,final.sessionId,final.ptyInfo);await ready();
    assert(await target.writeUserInput("printf '%s%s\\n' FINAL_NATIVE_ TEXT\r"),'Final native user input blocked');
    await until(()=>text(target).includes('FINAL_NATIVE_TEXT'),'Raw-to-native actual startup failed');assertPublic();
    stages.push({stage:'raw-to-native',text:text(target),raw:{...raw}});
    await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Real registry native/native/raw boundaries passed without reset or replay',evidence:{kind:'actual-tauri-registry-lifecycle',stages,allPublicApisUnmodified:true}})});
  }finally{disposers.forEach(dispose=>dispose());if(controller)terminalRegistry.dispose(controller.sessionId);for(const id of sessions)await invokeCloseSession(id).catch(()=>{});host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));

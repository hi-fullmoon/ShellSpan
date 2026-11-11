import {getCurrentWindow} from '@tauri-apps/api/window';
import {nativeP2Password} from './native-input-p2-credential';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCreateSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,
  invokeCheckHostKey,invokeTrustHost,invokeListAiRoutes} from '@/lib/ipc/tauri';
import type {SessionSummary} from '@/types';
import '@/styles/base.css';
import {verifyWindowsNativeLifecycle} from './native-input-windows-lifecycle';
import {isMacFileChainProfile} from './native-file-chain-posix';
import {verifyMacLateLifecycle} from './mac-late-lifecycle.native';
import {verifyMacDisposeLifecycle} from './mac-dispose.native';
import {macLifecycleCapture} from './mac-lifecycle-capture';
import {macLifecycleSurface} from './mac-lifecycle-surface';
import {macLifecyclePromptResidues} from './mac-lifecycle-prompt';

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
  if(parameters.get('nativeLocalLifecycleLate')==='true')return verifyMacLateLifecycle(parameters);
  if(parameters.get('nativeLocalLifecycleDispose')==='true')return verifyMacDisposeLifecycle(parameters);
  const local=parameters.get('nativeLocalLifecycle')==='true';
  const family=parameters.get('nativeP3')==='zsh'?'zsh':'bash';
  const port=Number(parameters.get('nativeP2SshPort'));assert(local||port>1024,'Owned SSH fixture required');
  const stages:unknown[]=[];const sessions:string[]=[],closeAttempted=new Set<string>();
  const capture=local?await macLifecycleCapture(parameters.get('token')!):undefined,surface=local?await macLifecycleSurface():undefined;
  const host=surface?.host??document.createElement('div');if(!surface){host.style.cssText='width:1100px;height:650px';document.body.append(host);}
  let controller:ReturnType<typeof terminalRegistry.create>|undefined,failed=false,problem:unknown;
  const raw:Record<string,string>={};
  const disposers:(()=>void)[]=[];
  const add=(session:SessionSummary)=>{sessions.push(session.sessionId);useTerminalStore.getState().addSession(session);};
  const send=async(source:string,label:string)=>{assert(controller,'Actual lifecycle controller missing');capture?.requireCleanInput();const accepted=await controller.writeUserInput(source);capture?.recordInput(source,accepted,label);return accepted;};
  const close=async(id:string)=>{assert(!closeAttempted.has(id),'Owned lifecycle close must not replay an unknown operation');closeAttempted.add(id);await invokeCloseSession(id);};
  const ready=async()=>{assert(controller,'Registry controller missing');await controller.whenOutputReady();await until(()=>!terminalInputReadiness.isPreparing(controller!.sessionId)&&useTerminalStore.getState().sessions.find(value=>value.sessionId===controller!.sessionId)?.status==='connected','Actual reconnect guard/status did not become ready');};
  const actualGeometry=async(width:number)=>{
    assert(surface&&capture&&controller,'Actual Mac lifecycle geometry requires the mounted owned surface');
    await capture.drain();const before={columns:controller.terminal.cols,rows:controller.terminal.rows,host:host.getBoundingClientRect().toJSON()};
    // Reconnect uses this existing fitted controller, not a second blank
    // calibration terminal appended to an already occupied host.
    host.style.width=width+'px';controller.fit();await capture.drain();const measured=controller.fitAddon.proposeDimensions();
    assert(measured&&measured.cols===controller.terminal.cols&&measured.rows===controller.terminal.rows,'Production host measurement and actual lifecycle controller geometry differ');
    stages.push({stage:'actual-host-geometry-before-replacement',requestedHostWidth:width,before,measured,host:host.getBoundingClientRect().toJSON()});return measured;
  };
  try{
    if(capture){const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'No-model local lifecycle requires an actually empty model route store');}
    const firstSize=surface?await surface.measureInitialDimensions():{cols:100,rows:30};assert(firstSize,'Actual initial lifecycle host could not be measured');
    const first=await invokeCreateLocalSession(firstSize.cols,firstSize.rows);add(first);await capture?.expect(first);
    assert(first.ptyInfo?.inputMode==='native-inline'&&first.ptyInfo.nativeDisplayBinding,'Normal native startup not negotiated');
    controller=terminalRegistry.create(first.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(value=>value.sessionId===id)?.status??'connecting',()=>{},first.ptyInfo);
    capture?.bind(controller);controller.attach(host);await controller.whenOutputReady();controller.focus();
    const target=controller;
    const nativeReady=async()=>{
      await until(async()=>{const value=(await invokeGetTerminalBrokerSnapshot(target.sessionId)).session;return !!value?.promptReady&&isMacFileChainProfile(value.nativePeerProfile,family);},'Actual selected local native profile/prompt missing');
      const current=(await invokeGetTerminalBrokerSnapshot(target.sessionId)).session;
      if(local)assert(current?.geometry.columns===target.terminal.cols&&current.geometry.rows===target.terminal.rows,'Actual selected native PTY and current lifecycle geometry differ');
      return current;
    };
    const initial=local?await nativeReady():undefined;
    await capture?.checkpoint('lifecycle-ready',{initial,session:first},true);
    disposers.push(target.subscribeOutput(chunk=>{raw[target.sessionId]=(raw[target.sessionId]??'')+chunk;}));
    const originals={selection:target.terminal.getSelection,open:target.terminal.open,getLine:Object.getPrototypeOf(target.terminal.buffer.normal).getLine};
    const assertPublic=()=>assert(target.terminal.getSelection===originals.selection&&target.terminal.open===originals.open&&target.terminal.buffer.normal.getLine===originals.getLine,'Native/raw rebind installed a renderer/selection/source override');
    const secondSize=local?await actualGeometry(440):{cols:40,rows:30};
    // Real ordinary program output deliberately enters display mode and ends
    // with a partial OSC. It has no Agent operation, proof or execute authority.
    assert(await send("printf '%s%s\\n' OLD_NATIVE_ OUTPUT; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ'; exec /bin/sleep 0.3\r",'native-half-osc-eof'),'Initial real user command blocked');
    await until(()=>target.terminal.options.reflowCursorLine===true,'Real producer did not enter native display');
    await until(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===first.sessionId)?.status==='disconnected','Real native EOF missing');
    await until(()=>target.terminal.options.reflowCursorLine===false,'EOF did not drain/dispose native display');
    assert(text(target).includes('OLD_NATIVE_OUTPUT'),'Native EOF lost historical output');assertPublic();
    await capture?.checkpoint('lifecycle-first-closed',{broker:await invokeGetTerminalBrokerSnapshot(first.sessionId)});
    const second=await invokeCreateLocalSession(secondSize.cols,secondSize.rows,first.sessionId);add(second);await capture?.expect(second);
    terminalRegistry.rebindSession(first.sessionId,second.sessionId,second.ptyInfo);await ready();
    const secondNative=local?await nativeReady():undefined;
    assert(await send("printf '%s%s\\n' NEW_NATIVE_ TEXT\r",'native-successor-output'),'Native rebind user input blocked');
    await until(()=>text(target).includes('NEW_NATIVE_TEXT'),'Native startup ESC did not terminate the old parser tail');
    assert(text(target).includes('OLD_NATIVE_OUTPUT'),'Native-to-native erased history');assertPublic();
    stages.push({stage:'native-to-native',old:first.sessionId,new:second.sessionId,initial,secondNative,text:text(target),raw:{...raw}});
    await capture?.checkpoint('lifecycle-native-native',{initial,secondNative},true);
    const rawSize=local?await actualGeometry(360):{cols:32,rows:30};
    // A real incomplete UTF-8 producer exits; the backend's streaming decoder
    // flushes its tail before registry disposal. No fake data event is injected.
    assert(await send("printf '%s%s\\n' UTF8_ BEFORE; printf '\\342\\202'; exec /bin/sleep 0.3\r",'native-half-utf8-eof'),'UTF-8 EOF command blocked');
    await until(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===second.sessionId)?.status==='disconnected','UTF-8 producer did not exit');
    await new Promise<void>(resolve=>target.terminal.write('',resolve));
    const utf8Tail=raw[second.sessionId]??'';
    if(local)assert(utf8Tail.includes('UTF8_BEFORE')&&utf8Tail.indexOf('UTF8_BEFORE')<utf8Tail.lastIndexOf('\uFFFD'),'Actual incomplete UTF-8 tail was not flushed in order before local rebind');
    await capture?.checkpoint('lifecycle-utf8-closed',{broker:await invokeGetTerminalBrokerSnapshot(second.sessionId)});
    if(!local){const key=await invokeCheckHostKey('127.0.0.1',port);assert(key.status==='match'||key.status==='notFound','Fixture host identity changed');if(key.status==='notFound'){assert(key.fingerprint,'Fixture fingerprint missing');await invokeTrustHost('127.0.0.1',port,key.fingerprint);}}
    // A legacy local client explicitly omits the native protocol on the normal
    // replacement API. The backend negotiates a real raw PTY without an adapter;
    // this is distinct from the existing unsupported-shell SSH case.
    const ordinary=local?await invokeCreateLocalSession(rawSize.cols,rawSize.rows,second.sessionId,null):await invokeCreateSession({name:'Owned raw Bash boundary',host:'127.0.0.1',port,username:'nativeRaw',authMethod:'password',password:await nativeP2Password(),terminalCols:32,terminalRows:30,replacesSessionId:second.sessionId});add(ordinary);await capture?.expect(ordinary);
    assert(ordinary.ptyInfo?.inputMode==='raw','Unverified actual shell did not initialize as raw');
    terminalRegistry.rebindSession(second.sessionId,ordinary.sessionId,ordinary.ptyInfo);await ready();
    const rawCommand=(local?"printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; ":'')+"printf '%s%s\\n' RAW_NEW_ TEXT\r";
    assert(await send(rawCommand,'raw-opt-out-ordinary-output'),'Actual raw shell was not usable');
    await until(()=>text(target).includes('RAW_NEW_TEXT'),'Raw text was swallowed by a prior OSC/UTF-8 parser tail');
    assert(text(target).includes('OLD_NATIVE_OUTPUT')&&text(target).includes('NEW_NATIVE_TEXT')&&text(target).includes('UTF8_BEFORE'),'Raw rebind erased prior history');
    assert(target.inputMode==='raw'&&target.terminal.options.reflowCursorLine===false,'Raw reused native display state');assertPublic();
    const snapshot=(await invokeGetTerminalBrokerSnapshot(ordinary.sessionId)).session;
    assert(snapshot?.inputMode==='raw'&&snapshot.integrationState!=='ready'&&!snapshot.inputObservation?.activeCommand,'Untrusted display created an executable native operation');
    if(local)assert(snapshot.geometry.columns===target.terminal.cols&&snapshot.geometry.rows===target.terminal.rows,'Actual raw opt-out PTY and current lifecycle geometry differ');
    stages.push({stage:'native-to-raw',snapshot,utf8Tail,rawSource:local?'local-client-native-protocol-opt-out':'unsupported-ssh-shell',text:text(target),raw:{...raw}});
    await capture?.checkpoint('lifecycle-raw',{broker:{session:snapshot},rawSource:'local-client-native-protocol-opt-out'},true);
    const finalSize=local?await actualGeometry(1100):{cols:180,rows:30};
    const final=await invokeCreateLocalSession(finalSize.cols,finalSize.rows,ordinary.sessionId);add(final);await capture?.expect(final);
    terminalRegistry.rebindSession(ordinary.sessionId,final.sessionId,final.ptyInfo);await ready();
    const finalNative=local?await nativeReady():undefined;
    assert(await send("printf '%s%s\\n' FINAL_NATIVE_ TEXT\r",'final-native-successor-output'),'Final native user input blocked');
    await until(()=>text(target).includes('FINAL_NATIVE_TEXT'),'Raw-to-native actual startup failed');assertPublic();
    if(local)for(const marker of ['OLD_NATIVE_OUTPUT','NEW_NATIVE_TEXT','UTF8_BEFORE','RAW_NEW_TEXT','FINAL_NATIVE_TEXT'])assert(text(target).includes(marker),'Final local native rebind lost actual historical output: '+marker);
    stages.push({stage:'raw-to-native',finalNative,text:text(target),raw:{...raw}});
    const promptResidues=local?macLifecyclePromptResidues(target.terminal):[];
    await capture?.checkpoint('lifecycle-final',{finalNative,promptResidues,broker:await invokeGetTerminalBrokerSnapshot(final.sessionId)},true);
    if(local)assert(promptResidues.length===0,'Actual lifecycle history contains an isolated inverse prompt marker');
    let observations;if(capture){for(const id of sessions)await close(id);observations=await capture.finish();}
    await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Real registry native/native/raw boundaries passed without reset or replay',evidence:{kind:'actual-tauri-registry-lifecycle',local,stages,observations,allPublicApisUnmodified:true}})});
  }catch(error){
    failed=true;problem=error;
    const retained=await capture?.diagnose().catch(diagnosticError=>({error:String(diagnosticError)}));
    await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Actual registry lifecycle failure retained before cleanup',evidence:{kind:'actual-tauri-registry-lifecycle',failed:true,local,family,reason:String(error),stages,raw,sessions,retained,broker:controller?await invokeGetTerminalBrokerSnapshot(controller.sessionId):undefined}})});
    throw error;
  }finally{disposers.forEach(dispose=>dispose());if(capture){
    const cleanupErrors:Record<string,unknown>[]=[];for(const id of sessions)if(!closeAttempted.has(id))try{await close(id);}catch(error){cleanupErrors.push({sessionId:id,stage:'normal-close',error:String(error)});}
    if(failed)try{await capture.diagnoseClosed();}catch(error){cleanupErrors.push({stage:'closed-failure-capture',error:String(error)});}
    if(cleanupErrors.length)await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({progress:'Actual lifecycle cleanup diagnostic errors retained',evidence:{kind:'actual-tauri-registry-lifecycle',failed:true,local,family,reason:String(problem??'Normal cleanup failed'),stages,raw,sessions,cleanupErrors}})});
    capture.stop();if(controller)terminalRegistry.dispose(controller.sessionId);surface?.unmount();
    if(cleanupErrors.length&&!failed)throw Error('Actual lifecycle normal cleanup failed; original errors retained');
   }else{if(controller)terminalRegistry.dispose(controller.sessionId);for(const id of sessions)await invokeCloseSession(id).catch(()=>{});host.remove();}}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));

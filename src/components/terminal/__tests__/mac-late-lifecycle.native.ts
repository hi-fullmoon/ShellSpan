import {terminalRegistry} from '../registry/terminal-registry';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {useTerminalStore} from '@/stores/terminalStore';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,
 listenToSshData,listenToSshClosed} from '@/lib/ipc/tauri';
import {isMacFileChainProfile} from './native-file-chain-posix';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+10000;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}}
type Frame={sessionId:string;capturedAtUnixMs:number;payload:string};
export async function verifyMacLateLifecycle(parameters:URLSearchParams) {
 assert(parameters.get('nativeLocalLifecycle')==='true','Exact local lifecycle admission missing');
 const token=parameters.get('token');assert(token,'Owned result token missing');
 const family=parameters.get('nativeP3')==='zsh'?'zsh':'bash';
 const endpoint=`/__native-local-late/${token}`;
 const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
 const sessions:string[]=[],frames:Frame[]=[],closed:Record<string,number>={},cleanup:unknown[]=[],dispose:(()=>void)[]=[];
 let controller:ReturnType<typeof terminalRegistry.create>|undefined,evidence:Record<string,unknown>|undefined,failure:unknown;
 const rendered=()=>{assert(controller,'Actual terminal missing');const b=controller.terminal.buffer.normal;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)??'').join('\n');};
 const watch=async(id:string)=>{dispose.push(await listenToSshData(id,({payload})=>{assert(frames.reduce((n,v)=>n+v.payload.length,0)+payload.length<131072,'Actual capture exceeds bound');frames.push({sessionId:id,capturedAtUnixMs:Date.now(),payload});}));dispose.push(await listenToSshClosed(id,()=>{closed[id]=Date.now();}));};
 const raw=(id:string)=>frames.filter(f=>f.sessionId===id).map(f=>f.payload).join('');
 const nativeReady=async(id:string)=>{await until(async()=>{const s=(await invokeGetTerminalBrokerSnapshot(id)).session;return !!s?.promptReady&&isMacFileChainProfile(s.nativePeerProfile,family)&&!terminalInputReadiness.isPreparing(id)&&useTerminalStore.getState().sessions.find(v=>v.sessionId===id)?.status==='connected';},'Actual native successor did not become ready');return (await invokeGetTerminalBrokerSnapshot(id)).session;};
 const close=async(id:string)=>{await invokeCloseSession(id);cleanup.push({sessionId:id,api:'close_session',acknowledgedAtUnixMs:Date.now()});await until(()=>!!closed[id],'Actual owned session close event missing');};
 try {
  const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'No-model late lifecycle requires an actually empty model route store');
  const first=await invokeCreateLocalSession(100,30);sessions.push(first.sessionId);useTerminalStore.getState().addSession(first);await watch(first.sessionId);
  controller=terminalRegistry.create(first.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(s=>s.sessionId===id)?.status??'connecting',()=>{},first.ptyInfo);
  controller.attach(host);await controller.whenOutputReady();const initial=await nativeReady(first.sessionId);
  const original={selection:controller.terminal.getSelection,open:controller.terminal.open,line:controller.terminal.buffer.normal.getLine};
  const oldSource="printf '%s%s\\n' OLD_WAIT_ READY; lifecycle_wait=0; while [ ! -e \"$HOME/lifecycle-late-release\" ] && [ \"$lifecycle_wait\" -lt 1500 ]; do lifecycle_wait=$((lifecycle_wait+1)); /bin/sleep 0.02; done; if [ -e \"$HOME/lifecycle-late-release\" ]; then printf '%s%s\\n' OLD_LATE_ OUTPUT && printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007\\033[6n' && printf '%s%s\\n' OLD_LATE_ CONTROL && printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA==\\007' && printf '%s%s\\n' OLD_LATE_ EFFECT > \"$HOME/lifecycle-late-effect\"; else printf '%s%s\\n' OLD_GATE_ TIMEOUT; fi";
  assert(await controller.writeUserInput(oldSource+'\r'),'Real old producer input blocked');
  await until(()=>raw(first.sessionId).includes('OLD_WAIT_READY'),'Actual old producer did not reach its gate');
  const second=await invokeCreateLocalSession(80,30,first.sessionId);sessions.push(second.sessionId);useTerminalStore.getState().addSession(second);await watch(second.sessionId);
  terminalRegistry.rebindSession(first.sessionId,second.sessionId,second.ptyInfo);await controller.whenOutputReady();
  await nativeReady(second.sessionId);
  assert(await controller.writeUserInput("printf '%s%s\\n' NEW_READY_ OUTPUT\r"),'Actual successor input blocked');
  await until(()=>raw(second.sessionId).includes('NEW_READY_OUTPUT'),'Actual successor output missing before old gate release');
  const before=await nativeReady(second.sessionId),successorReadyAtUnixMs=Date.now();
  assert(initial&&before&&initial.terminalSessionId===before.terminalSessionId&&before.terminalGeneration===initial.terminalGeneration+1,'Replacement identity/generation differs');
  const releaseResponse=await fetch(endpoint+'/release',{method:'POST'});assert(releaseResponse.ok,'Owned old producer release failed');
  const release=await releaseResponse.json() as {released:boolean;releasedAtUnixMs:number};assert(release.released&&release.releasedAtUnixMs>=successorReadyAtUnixMs,'Gate was released before the actual successor was ready');
  await until(()=>raw(first.sessionId).includes('OLD_LATE_OUTPUT')&&raw(first.sessionId).includes('OLD_LATE_CONTROL'),'Real old transport did not deliver its late output');
  await until(async()=>{const response=await fetch(endpoint+'/status');assert(response.ok,'Owned late effect lookup failed');const value=await response.json() as {effect:string|null};return value.effect==='OLD_LATE_EFFECT\n';},'Actual gated old producer did not finish its output');
  const lateFrames=frames.filter(f=>f.sessionId===first.sessionId&&f.payload.includes('OLD_LATE_OUTPUT'));assert(lateFrames.length>0&&lateFrames.every(f=>f.capturedAtUnixMs>=release.releasedAtUnixMs),'Late bytes lack actual old-transport/time provenance');
  assert(raw(first.sessionId).includes('\u001b[6n')&&raw(first.sessionId).includes('\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ==\u0007'),'Actual old display/control output missing');
  assert(!raw(second.sessionId).includes('OLD_LATE_OUTPUT')&&!raw(second.sessionId).includes('OLD_LATE_CONTROL'),'Old data entered the successor transport');
  await new Promise<void>(resolve=>controller!.terminal.write('',resolve));
  assert(!rendered().includes('OLD_LATE_OUTPUT')&&!rendered().includes('OLD_LATE_CONTROL'),'Retired listener rendered late old bytes on the successor');
  assert(controller.terminal.options.reflowCursorLine===false,'Old display enter changed the successor baseline');
  const afterLate=await nativeReady(second.sessionId);
  assert(afterLate&&afterLate.terminalGeneration===before.terminalGeneration&&afterLate.integrationId===before.integrationId&&afterLate.nextInputSequence===before.nextInputSequence,'Old DSR/control output changed successor identity or input sequence');
  assert(!(await invokeGetTerminalBrokerSnapshot(first.sessionId)).session,'Retired transport still resolves to a live Broker session');
  await close(first.sessionId);
  assert(await controller.writeUserInput("printf '%s%s\\n' NEW_ALIVE_ OUTPUT\r"),'Successor input failed after normal old transport teardown');
  await until(()=>raw(second.sessionId).includes('NEW_ALIVE_OUTPUT'),'Successor stopped producing after old teardown');
  const afterClose=await nativeReady(second.sessionId);
  assert(afterClose&&afterClose.integrationId===before.integrationId&&afterClose.terminalGeneration===before.terminalGeneration,'Old close affected successor control identity');
  assert(rendered().includes('OLD_WAIT_READY')&&rendered().includes('NEW_READY_OUTPUT')&&rendered().includes('NEW_ALIVE_OUTPUT'),'Rebind erased genuine earlier output');
  assert(controller.terminal.getSelection===original.selection&&controller.terminal.open===original.open&&controller.terminal.buffer.normal.getLine===original.line,'Late lifecycle installed public terminal overrides');
  evidence={kind:'actual-macos-late-transport-lifecycle',family,modelRoutes:0,initial,before,afterLate,afterClose,successorReadyAtUnixMs,release,oldSource,frames,lateFrames,text:rendered(),oldTransport:first.sessionId,newTransport:second.sessionId,publicApisUnmodified:true};
 }catch(error){failure=error;}
 finally {
  for(const id of sessions)if(!closed[id])try{await close(id);}catch(error){cleanup.push({sessionId:id,error:String(error)});failure??=error;}
  if(controller)terminalRegistry.dispose(controller.sessionId);dispose.forEach(f=>f());host.remove();
 }
 await fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({progress:failure?'Actual late transport failure retained':'Actual old output isolated after successor readiness and normal old teardown',evidence:{...evidence,family,sessions,failed:!!failure,reason:failure?String(failure):undefined,frames,closed,cleanup}})});
 if(failure)throw failure;
}

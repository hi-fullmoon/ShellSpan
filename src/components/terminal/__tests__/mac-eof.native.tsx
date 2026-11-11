import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {Terminal} from '@xterm/xterm';
import {UnicodeGraphemesAddon} from '@xterm/addon-unicode-graphemes';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {AppShell} from '@/components/layout/app-shell';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,invokeGetTerminalAcceptanceRawOutput,invokeCreateAgentRuntimeSession,invokePrepareTerminalAcceptanceRawCommand} from '@/lib/ipc/tauri';
import {macHumanCapture} from './mac-human-capture';
import {macEofPlan} from './mac-eof-plan';
import {isMacFileChainProfile} from './native-file-chain-posix';
import '@/styles/base.css';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(check:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
async function verify(){
 await initI18n('zh-CN');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),selection=parameters.get('macDaily');
 assert(token&&['eof-zsh','eof-bash','eof-natural-zsh','eof-natural-bash','eof-private-zsh','eof-private-bash','eof-owned-zsh','eof-owned-bash'].includes(selection??''),'Exact no-model automatic EOF entry required');
 const family=selection!.endsWith('-zsh')?'zsh':'bash',privateEof=selection!.startsWith('eof-private-'),ownedEof=selection!.startsWith('eof-owned-'),extended=privateEof||ownedEof,natural=selection!.startsWith('eof-natural-')||extended,variant=privateEof?'private-control-eof':ownedEof?'owned-natural-eof':natural?'natural-partial-utf8':'explicit-close',plan=macEofPlan(token),capture=await macHumanCapture(token,'automatic',{parsedOutputOrder:privateEof});
 const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'Automatic EOF cannot select a model');
 const session=await invokeCreateLocalSession(100,30);assert(session.terminalSessionId&&session.terminalGeneration!==undefined,'Actual Broker identity missing');
 await capture.expect(session.sessionId,session.ptyInfo,{terminalSessionId:session.terminalSessionId,terminalGeneration:session.terminalGeneration});
 useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);
 useAppStore.getState().setActiveSection('terminal');
 const root=createRoot(document.getElementById('root')!);
 function Pane(){const activeSession=useTerminalStore(state=>state.sessions.find(value=>value.sessionId===session.sessionId)??null);return <AppShell><div className="min-h-0 flex-1"><TerminalControllerLayer/><TerminalPane activeSession={activeSession} isActive isVisible/></div></AppShell>;}
 root.render(<Pane/>);let closeRequested=false,problem:unknown,closeMilliseconds:number|undefined;
 const commands:Record<string,unknown>[]=[],observations:Record<string,unknown>[]=[],preparations:Record<string,unknown>[]=[];
 const snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId),controller=()=>{assert(capture.controller,'Actual production controller missing');return capture.controller;};
 const idle=async()=>{const value=(await snapshot()).session;return !!value?.promptReady&&!value.inputObservation?.commandInputPending&&!value.inputObservation?.nativeRecoveryRequired;};
 const send=async(source:string,label:string)=>{const at=Date.now(),accepted=await controller().writeUserInput(source);commands.push({at,label,source,inputHex:Array.from(new TextEncoder().encode(source),byte=>byte.toString(16).padStart(2,'0')).join(''),accepted,physicalInputClaim:false});assert(accepted,'Actual ordinary EOF input rejected: '+label);};
 const witness=async()=>{const response=await fetch('/__native-mac-eof-witness/'+token);assert(response.ok,'Read-only actual effect witness unavailable');const value=await response.json() as {exists:boolean;file:string;readOnly:boolean};assert(value.readOnly&&!value.exists,'Cancelled draft created a real effect');return value;};
 const drain=async()=>{await new Promise<void>(done=>controller().terminal.write('',done));await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));await new Promise<void>(done=>controller().terminal.write('',done));};
 const layout=()=>{
  const titlebar=document.querySelector<HTMLElement>('[data-tauri-drag-region]'),host=controller().host,screen=controller().terminal.element?.querySelector<HTMLElement>('.xterm-screen');assert(titlebar&&host&&screen,'Actual production AppShell/TitleBar and terminal elements required');
  const chrome=titlebar.getBoundingClientRect(),surface=host.getBoundingClientRect(),cells=screen.getBoundingClientRect();
  assert(chrome.height>0&&surface.height>0&&surface.top>=chrome.bottom&&surface.bottom<=innerHeight&&surface.right<=innerWidth,'Actual terminal host overlaps native titlebar region or viewport');
  assert(cells.width>0&&cells.height>0&&cells.left>=surface.left&&cells.top>=surface.top&&cells.right<=surface.right&&cells.bottom<=surface.bottom,'Actual terminal cells are cropped by their host');
  return{titlebar:chrome.toJSON(),host:surface.toJSON(),screen:cells.toJSON(),viewport:{width:innerWidth,height:innerHeight},cols:controller().terminal.cols,rows:controller().terminal.rows};
 };
 try{
  await until(()=>!!capture.controller?.host,'Actual EOF pane did not attach');await controller().whenOutputReady();await until(idle,'Actual EOF native prompt missing');
  const initial=await snapshot();assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Actual native EOF profile differs');
  const calibration=new Terminal({allowProposedApi:true,reflowCursorLine:false}),baseline={unicode:calibration.unicode.activeVersion,reflow:calibration.options.reflowCursorLine,scope:'unattached package-default calibration only; no execution or display evidence'};calibration.dispose();
  const t=controller().terminal,reflow=()=>t.options.reflowCursorLine;assert(reflow()===false,'Initial native idle baseline differs');
  const scopedIdle={unicode:t.unicode.activeVersion,reflow:reflow()};assert(scopedIdle.unicode==='11'&&initial.session?.inputObservation&&!initial.session.activeCommandId,'Actual Mac idle provider/observation baseline missing');
  const readyLayout=layout(),nativeInnerSize=await getCurrentWindow().innerSize(),narrowRepresentative=privateEof&&initial.session?.nativePeerProfile?.verifiedProfileId==='gnu-bash-4.1-readline-6.0-macos-arm64-native';
  await capture.checkpoint('eof-ready',{family,natural,variant,session,initial,broker:initial,routes,baseline,scopedIdle,layout:readyLayout,nativeInnerSize,narrowRepresentative,windowSizing:narrowRepresentative?'Actual system mouse during image barriers; no application window mutation permission':undefined,humanReceipt:false},true);
  if(narrowRepresentative){await until(()=>innerWidth<=1200&&innerHeight<=760&&t.cols<readyLayout.cols,'Actual system-resized narrow native window/grid did not settle');await drain();observations.push({stage:'system-window-narrow',layout:layout(),nativeInnerSize:await getCurrentWindow().innerSize()});}
  capture.releaseInitial();
  const beforeEffect=await witness();await send(plan.cancelSource,'unsubmitted-cancel-draft');await until(()=>capture.raw.includes('SHOULD_NOT_EXECUTE'),'Actual ordinary draft echo missing');
  await send('\x03','ordinary-cancel');await until(idle,'Actual cancel did not recover prompt');await send('\r','next-enter');await until(idle,'Next Enter did not recover');
  const recovery=plan.prefix+'RECOVERED\r\n';await send(plan.marker('RECOVERED')+'\r','cancel-recovery-command');await until(()=>capture.raw.includes(recovery),'Independent cancel recovery stdout missing');await until(idle,'Recovery prompt missing');
  assert(reflow()===false,'Cancel changed idle display baseline');const afterEffect=await witness();
  await capture.checkpoint('eof-cancelled',{beforeEffect,afterEffect,broker:await snapshot(),commands,humanReceipt:false});
  const modes=extended?[plan.enter,plan.enter,plan.exit,plan.exit,plan.enter,plan.exit]:[plan.enter,plan.exit,plan.enter,plan.exit],enabled=extended?[true,true,false,false,true,false]:[true,false,true,false];
  for(const [index,source]of modes.entries()){
   const suffix='MODE_'+index,expected=plan.prefix+suffix+'\r\n';await send(source+'; '+plan.marker(suffix)+'\r',suffix);await until(()=>capture.raw.includes(expected),'Actual mode producer output missing');await until(idle,'Mode producer prompt missing');await drain();
   assert(reflow()===enabled[index]&&t.unicode.activeVersion===scopedIdle.unicode,'Actual owned/repeated enter/exit option or provider mismatch');const observation={index,reflow:t.options.reflowCursorLine,unicode:t.unicode.activeVersion,broker:await snapshot()};observations.push(observation);await capture.checkpoint('eof-mode-'+index,{observation,humanReceipt:false});
  }
  if(privateEof){
   const before=await snapshot();
   await send(plan.privateClose(family)+'\r','actual-private-channel-close');
   await until(()=>capture.raw.includes(plan.prefix+'PRIVATE_CLOSED\r\n'),'Actual private-close command did not return stdout');
   assert(capture.raw.includes(plan.prefix+'PRIVATE_CLOSE_STATUS_0\r\n'),'Actual module close/unload command failed; later printf must not mask its status');
   await until(async()=>{const value=(await snapshot()).session;return !!value&&value.integrationState==='unavailable'&&value.integrationReason==='nativeControlClosed';},'Actual private channel closure was not observed by production runtime');await drain();
   const revoked=await snapshot();observations.push({stage:'actual-private-eof',before,revoked,display:{unicode:t.unicode.activeVersion,reflow:reflow()}});
   await capture.checkpoint('eof-private-observed',{before,broker:revoked,variant,humanReceipt:false});
   assert(revoked.session?.open&&revoked.session.terminalSessionId===session.terminalSessionId&&revoked.session.terminalGeneration===session.terminalGeneration&&!capture.closedObserved&&!capture.wireFinalized,'Private EOF incorrectly ended or replaced the actual PTY');
   assert(revoked.session.inputObservation&&!revoked.session.inputObservation.nativeClearPending&&!revoked.session.inputObservation.nativeRecoveryRequired&&!revoked.session.inputObservation.commandInputPending&&!revoked.session.activeCommandId,'Idle private EOF invented a clear/recovery or command settlement');
   assert(reflow()===scopedIdle.reflow&&t.unicode.activeVersion===scopedIdle.unicode,'Private EOF changed the live session idle display baseline');
   const readonlyBefore=await snapshot();await invokeGetTerminalAcceptanceRawOutput(session.sessionId);const readonlyAfter=await snapshot();assert(readonlyBefore.session?.nextInputSequence===readonlyAfter.session?.nextInputSequence&&readonlyAfter.session?.integrationReason==='nativeControlClosed','Private EOF readonly query granted input or native readiness');
   const home=initial.session?.currentDirectory;assert(home,'Actual isolated HOME missing');const id='private-eof-'+crypto.randomUUID(),target={kind:'local' as const,targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:home,localRoot:home};
   const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Verify actual private control EOF refuses preparation without executing Agent source',target,permissionMode:'requestApproval',executionSurface:'boundTerminal',capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange'],targetIds:[target.targetId]}});assert(!created.header.modelSelection,'Private EOF preparation selected a model');
   for(const background of [false,true]){
    const result=await invokePrepareTerminalAcceptanceRawCommand(id,background);preparations.push({background,result});
    assert(result.stage==='installed NativeToolAdapter.prepare'&&result.rejection?.startsWith('TERMINAL_VISIBLE_COMMAND_UNAVAILABLE')&&!result.unexpectedPreparationAbandoned,'Actual private EOF source/job did not refuse at production preparation: '+result.rejection);
    assert(result.brokerBefore.session?.nextInputSequence===result.brokerAfter.session?.nextInputSequence&&result.brokerAfter.session?.integrationReason==='nativeControlClosed','Private EOF preparation wrote Agent source or restored native capability');
    assert(result.recoveryBefore.length===0&&result.recoveryAfter.length===0&&!result.effectBefore&&!result.effectAfter,'Private EOF preparation persisted a submission or effect');
    assert(result.headerBefore.executionSurface==='boundTerminal'&&result.sessionAfter.header.executionSurface==='boundTerminal','Private EOF preparation fell back to Direct');
   }
   await send(plan.marker('PRIVATE_RECOVERED')+'\r','ordinary-input-after-private-eof');await until(()=>capture.raw.includes(plan.prefix+'PRIVATE_RECOVERED\r\n'),'Private EOF lost ordinary user input/output');await drain();
   if(narrowRepresentative)assert(innerWidth<=1200&&innerHeight<=760&&t.cols<readyLayout.cols,'Actual system-resized native window did not remain narrow');
   await capture.checkpoint('eof-private-live',{variant,broker:await snapshot(),before,revoked,readonlyBefore,readonlyAfter,preparations,agentSession:created,scopedIdle,layout:layout(),narrowRepresentative,humanReceipt:false},true);
   if(narrowRepresentative){await until(()=>innerWidth===readyLayout.viewport.width&&innerHeight===readyLayout.viewport.height&&t.cols===readyLayout.cols,'Actual system-restored native window/grid did not restore');await drain();observations.push({stage:'system-window-restored',layout:layout(),nativeInnerSize:await getCurrentWindow().innerSize()});}
   await send(plan.natural+'\r','natural-partial-utf8-after-private-eof');
  }else if(natural&&!ownedEof){
   const before=await snapshot();await drain();t.loadAddon(new UnicodeGraphemesAddon());capture.observeUnicodeVersion('graphemes');assert(t.unicode.activeVersion==='15-graphemes','Actual external provider did not activate');
   const after=await snapshot();assert(before.session?.nextInputSequence===after.session?.nextInputSequence,'Public provider change granted terminal input');
   await send(plan.enter+'; '+plan.marker('EXTERNAL_ENTER')+'\r','external-provider-enter');await until(()=>capture.raw.includes(plan.prefix+'EXTERNAL_ENTER\r\n'),'External enter output missing');await until(idle,'External provider enter prompt missing');await drain();assert(t.unicode.activeVersion==='15-graphemes'&&reflow()===true,'Owned enter overwrote external provider');
   await send(plan.exit+'; '+plan.marker('EXTERNAL_EXIT')+'\r','external-provider-exit');await until(()=>capture.raw.includes(plan.prefix+'EXTERNAL_EXIT\r\n'),'External exit output missing');await until(idle,'External provider exit prompt missing');await drain();assert(t.unicode.activeVersion==='15-graphemes'&&reflow()===false,'Owned exit overwrote external provider');
   observations.push({stage:'external-provider-preserved',before,after,unicode:t.unicode.activeVersion,reflow:t.options.reflowCursorLine});await capture.checkpoint('eof-external-preserved',{before,after,broker:await snapshot(),humanReceipt:false});
   await send(plan.natural+'\r','natural-partial-utf8-exit');
  }else if(ownedEof){
   await send(plan.natural+'\r','owned-natural-partial-utf8-exit');
  }else{
   await send(plan.setup+'\r','actual-hup-tail-install');await until(()=>capture.raw.includes(plan.armed),'Actual HUP producer was not armed');await until(idle,'Armed native prompt missing');await drain();assert(reflow()===true,'Actual ordinary producer did not enter native display');
   await capture.checkpoint('eof-armed',{broker:await snapshot(),commands,observations,plan:{tail:plan.tail,partial:plan.partial},humanReceipt:false},true);
   closeRequested=true;const began=performance.now();await invokeCloseSession(session.sessionId);closeMilliseconds=performance.now()-began;
  }
  await until(()=>capture.closedObserved&&capture.wireFinalized,'Actual closed event or worker finalization missing');
  const expectedProvider=natural&&!extended?'15-graphemes':baseline.unicode;
  await until(()=>reflow()===false&&t.unicode.activeVersion===expectedProvider,'Real transport closure did not restore or preserve the correct display provider');await drain();
  if(natural){assert(capture.raw.includes(plan.naturalMarker)&&capture.raw.endsWith('\ufffd'),'Actual incomplete UTF8 tail was not flushed at EOF');closeRequested=true;await invokeCloseSession(session.sessionId);}
  else assert(capture.raw.split(plan.tail).length===2&&capture.raw.includes(plan.partial),'Actual HUP tail/partial OSC missing or repeated');
  const closed=await snapshot();assert(closed.session?.open===false,'Actual Broker closure missing');
  await capture.checkpoint('eof-closed',{family,natural,variant,session,broker:closed,commands,observations,preparations,closeMilliseconds,expectedProvider,layout:layout(),humanReceipt:false},true);
  await capture.finish(session.sessionId,{kind:'actual-macos-eof-automatic',family,natural,variant,session,commands,observations,preparations,closeMilliseconds,modelCalls:0,agentSubmissions:0,humanReceipt:false,physicalInputClaim:false,scope:'Actual ordinary producer and production close/EOF path; no real-user acceptance or whole-phase claim.'});
 }catch(error){problem=error;
  if(!closeRequested&&!capture.closedObserved){closeRequested=true;try{await invokeCloseSession(session.sessionId);}catch(closeError){observations.push({cleanupError:String(closeError)});}}
  await capture.diagnose(session.sessionId).catch(diagnosticError=>observations.push({diagnosticError:String(diagnosticError)}));
  await capture.post({ok:false,error:String(problem),evidence:{kind:'actual-macos-eof-automatic-failure',family,natural,variant,session,commands,observations,preparations,records:capture.records,lifecycle:capture.lifecycle,humanReceipt:false,physicalInputClaim:false,modelCalls:0,agentSubmissions:0}});
 }finally{terminalRegistry.dispose(session.sessionId);root.unmount();}
}
void verify().catch(error=>{const token=new URL(location.href).searchParams.get('token');void fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(error),evidence:{kind:'actual-macos-eof-preparation-failure',humanReceipt:false}})});});

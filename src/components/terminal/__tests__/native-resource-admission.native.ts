import {getCurrentWindow} from '@tauri-apps/api/window';
import {terminalRegistry} from '../registry/terminal-registry';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
import '@/styles/base.css';

declare const __PACKAGE_REPORT__:string;
declare const __PACKAGE_NATIVE_SHA__:string;
declare const __PACKAGE_SHELL_KIND__:string;
declare const __PACKAGE_SHELL_VERSION__:string;
type CasePlan={index:number;name:string;expectedNative:boolean;expectedRaw:boolean;explicitAbiRefusal:boolean};
type Receipt=Record<string,unknown>;
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await test()){assert(Date.now()<end,message);await pause(25);}}
async function bootstrapCount(){const response=await fetch(__PACKAGE_REPORT__+'/admission');assert(response.ok,'Admission witness failed');const body:unknown=await response.json();assert(body&&typeof body==='object'&&'nativeBootstrap'in body&&Array.isArray(body.nativeBootstrap),'Invalid bootstrap witness');return body.nativeBootstrap.length;}
async function execute(){
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const title=document.createElement('p'),host=document.createElement('div');title.textContent='Isolated installed resource admission verification';host.style.cssText='width:100vw;height:85vh';document.body.append(title,host);const receipts:Receipt[]=[];
 for(let index=0;index<9;index++){
  const response=await fetch(__PACKAGE_REPORT__+'/admission',{method:'POST',body:JSON.stringify({index})});assert(response.ok,'Controlled resource switch failed');const plan=await response.json() as CasePlan;assert(plan.index===index,'Admission order changed');title.textContent=`Resource admission: ${plan.name}`;
  const session=await invokeCreateLocalSession(100,30);useTerminalStore.getState().addSession(session);
  const controller=terminalRegistry.create(session.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(value=>value.sessionId===id)?.status??'connecting',()=>{},session.ptyInfo);
  let raw='',passed=false,error:string|undefined,writeAccepted=false,loadedCore:ReturnType<typeof readNativeFileLoadedCore>=null;
  const unsubscribe=controller.subscribeOutput(value=>{if(raw.length<524288)raw+=value;});
  const lines=()=>Array.from({length:controller.terminal.buffer.normal.length},(_,row)=>controller.terminal.buffer.normal.getLine(row)?.translateToString(true)??'');
  try{
   controller.attach(host);await controller.whenOutputReady();
   if(plan.expectedNative){await until(async()=>{const value=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;return !!value?.promptReady&&isCurrentNativeEditorProfile(value.nativePeerProfile,value.integrationShell??null);},'Valid installed native provider did not bind');}
   else if(plan.expectedRaw){assert(session.ptyInfo?.inputMode==='raw','Invalid resource was not rejected before host mode selection');}
   else{
    await until(()=> (raw+lines().join('')).replace(/\s/g,'').includes('TERMINAL_NATIVE_REQUIRED_SYMBOL_UNAVAILABLE'),'ABI rejection was not observed in actual startup output');
    await pause(500);assert(!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.nativePeerProfile,'ABI-invalid provider granted a native peer');
   }
   await until(()=>!terminalInputReadiness.isPreparing(session.sessionId)&&useTerminalStore.getState().sessions.find(value=>value.sessionId===session.sessionId)?.status==='connected','Ordinary terminal remained unavailable after admission decision');
   const marker=`ADMISSION_USER_${index}_OK`,source=(plan.expectedNative?nativeFileCoreSetup+'; ':'')+`[Console]::WriteLine('ADMISSION_USER_${index}_'+'OK')`;
   writeAccepted=await controller.writeUserInput(source+'\r');assert(writeAccepted,'Ordinary user input was blocked');await until(()=>lines().some(line=>line.trim()===marker),'Ordinary user output missing');assert(lines().filter(line=>line.trim()===marker).length===1,'Ordinary output duplicated');
   const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(!snapshot.session?.inputObservation?.activeCommand,'Ordinary user command became an Agent operation');
   if(plan.expectedNative){assert(snapshot.session?.nativePeerProfile?.shell===__PACKAGE_SHELL_KIND__&&snapshot.session.nativePeerProfile.shellVersion===__PACKAGE_SHELL_VERSION__,'Host identity changed');loadedCore=readNativeFileLoadedCore(raw);assert(loadedCore?.sha256===__PACKAGE_NATIVE_SHA__,'Wrong native module loaded');}
   else assert(!snapshot.session?.nativePeerProfile,'Rejected resource acquired native capability');
   passed=true;
  }catch(reason){error=String(reason);}
  finally{
   const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId).catch(()=>null);receipts.push({plan,session,passed,error,writeAccepted,loadedCore,snapshot,raw});unsubscribe();await invokeCloseSession(session.sessionId);terminalRegistry.dispose(session.sessionId);host.replaceChildren();await until(async()=>await bootstrapCount()===0,'Actual host bootstrap was not cleaned after close');
   await fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({progress:true,evidence:{kind:'installed-resource-admission-progress',receipts}})});
  }
 }
 const capture=await fetch(__PACKAGE_REPORT__+'/capture',{method:'POST'});assert(capture.ok,'Owned admission screenshot failed');
 return {ok:receipts.every(receipt=>receipt.passed),error:receipts.some(receipt=>!receipt.passed)?'Installed admission case failed':undefined,evidence:{kind:'actual-installed-resource-admission',receipts,scope:'Actual installed application resource refusals and ordinary user availability. No model/Agent source command,approval bypass,production admission or whole A03 claim.'}};
}
void execute().then(value=>value,reason=>({ok:false,error:String(reason)})).then(value=>fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify(value)}));

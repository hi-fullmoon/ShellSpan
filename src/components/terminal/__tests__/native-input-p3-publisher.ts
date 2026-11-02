import {invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import {terminalRegistry} from '../registry/terminal-registry';

const accepted=new Set<string>();
function waitingPrompt(controller:ReturnType<typeof terminalRegistry.create>){
 const buffer=controller.terminal.buffer.active;const row=buffer.baseY+buffer.cursorY;
 const lines=Array.from({length:Math.min(20,row+1)},(_,index)=>{
  const current=row-Math.min(19,row)+index;
  return buffer.getLine(current)?.translateToString(true,0,current===row?buffer.cursorX:undefined).trim()??'';
 });
 const text=lines.join('').replace(/\s/g,'');
 return text.endsWith('(defaultis"D"):')&&text.includes('Doyouwanttorunsoftwarefromthisuntrustedpublisher?')&&text.includes('[R]Runonce')&&text.includes('[A]Alwaysrun')?{text,row,cursor:buffer.cursorX}:undefined;
}
export async function acceptP3PublisherOnce(controller:ReturnType<typeof terminalRegistry.create>,parameters:URLSearchParams):Promise<void>{
 if(parameters.get('nativeP3PublisherRunOnce')!=='true'||accepted.has(controller.sessionId))return;
 // Compare this known path with actual public cells. No path is parsed from
 // terminal escape sequences or arbitrary error text.
 const waiting=waitingPrompt(controller);if(!waiting)return;
 const before=(await invokeGetTerminalBrokerSnapshot(controller.sessionId)).session;
 if(before?.inputMode!=='native-inline'||before.integrationShell!=='windowsPowerShell'||before.transportKind!=='windowsConPty'||before.promptReady||before.integrationState==='ready'||before.integrationReason!=null||before.nativePeerProfile||before.inputObservation?.activeCommand||before.lease?.owner.kind!=='user'||before.nextInputSequence!==1)return;
 accepted.add(controller.sessionId);
 const response=await fetch(`/__native-p3-publisher/${parameters.get('token')}`,{method:'POST',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('Actual publisher verification failed');
 const value:unknown=await response.json();
 if(!value||typeof value!=='object'||!('file'in value)||typeof value.file!=='string'||!waiting.text.includes(value.file.replace(/\s/g,''))||!('signatureStatus'in value)||value.signatureStatus!=='Valid'||!('sha256'in value)||value.sha256!=='1ca887463598d38aa18236a97a4193b2228d1d8434fa73cc8c7932f42a0565cf'||!('choice'in value)||value.choice!=='RunOnceR')throw new Error('Actual publisher prompt does not match the approved file');
 const identity=(await invokeGetTerminalBrokerSnapshot(controller.sessionId)).session;
 const current=waitingPrompt(controller);
 if(identity?.inputMode!=='native-inline'||identity.integrationShell!=='windowsPowerShell'||identity.transportKind!=='windowsConPty'||identity.promptReady||identity.integrationState==='ready'||identity.integrationReason!=null||identity.nativePeerProfile||identity.inputObservation?.activeCommand||identity.lease?.owner.kind!=='user'||identity.terminalSessionId!==before.terminalSessionId||identity.transportSessionId!==before.transportSessionId||identity.terminalGeneration!==before.terminalGeneration||identity.nextInputSequence!==before.nextInputSequence||identity.nextOutputSequence!==before.nextOutputSequence||!current||current.text!==waiting.text||current.row!==waiting.row||current.cursor!==waiting.cursor)return;
 if(!await controller.writeUserInput('R\r'))throw new Error('Actual user-owned publisher choice was blocked');
}

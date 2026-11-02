import {getCurrentWindow} from '@tauri-apps/api/window';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import '@/styles/base.css';
declare const __NATIVE_P2_RELEASE_REPORT__:string;

async function verify(){
  await initI18n('en-US');await getCurrentWindow().show();
  const session=await invokeCreateLocalSession(100,30);
  useTerminalStore.getState().addSession(session);
  let controller:ReturnType<typeof terminalRegistry.create>|undefined;
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  try{
    if(session.ptyInfo?.inputMode!=='native-inline'||!session.ptyInfo.nativeDisplayBinding)throw new Error('Packaged resource root failed native negotiation');
    const broker=await invokeGetTerminalBrokerSnapshot(session.sessionId);
    if(broker.session?.integrationState!=='ready')throw new Error('Packaged native module did not pass actual private capability negotiation');
    controller=terminalRegistry.create(session.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(value=>value.sessionId===id)?.status??'connecting',()=>{},session.ptyInfo);
    controller.attach(host);await controller.whenOutputReady();
    let raw='';const dispose=controller.subscribeOutput(chunk=>{raw+=chunk;});
    try{
      if(!await controller.writeUserInput("printf '%s%s\\n' PACKAGED_NATIVE_ RESOURCE_OK\r"))throw new Error('Packaged native user input blocked');
      const deadline=Date.now()+10000;
      while(!raw.includes('PACKAGED_NATIVE_RESOURCE_OK\r\n')){if(Date.now()>deadline)throw new Error('Actual packaged PTY output missing');await new Promise(resolve=>setTimeout(resolve,10));}
      return {ok:true,kind:'actual-release-bundle-resource-smoke',ptyInfo:session.ptyInfo,broker,raw};
    }finally{dispose();}
  }finally{await invokeCloseSession(session.sessionId);terminalRegistry.dispose(session.sessionId);host.remove();}
}
void verify().catch((error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)}))
  .then(value=>fetch(__NATIVE_P2_RELEASE_REPORT__,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));

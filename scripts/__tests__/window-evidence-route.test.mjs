import fs from 'node:fs';
import p from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer,preview} from 'vite';
import {expect,it} from 'vitest';
import {attachNativeWindowEvidence} from '../native-input-p3/window-evidence-route.mjs';
import {closeNativeValidationServer} from '../native-input-p3/close-validation-server.mjs';
import {nativePackageEndpoint} from '../../src/components/terminal/__tests__/native-package-endpoint';

async function fixture(mode,selection,capture,client='relative'){
 const root=p.resolve(import.meta.dirname,'../../.artifacts/tests/window-evidence-route',randomUUID()),token=randomUUID();
 fs.mkdirSync(p.join(root,'assets'),{recursive:true});fs.writeFileSync(p.join(root,'assets/index.html'),'<!doctype html><title>Component HTTP routing only</title>');
 let attached=false;
 const install=server=>{attached=attachNativeWindowEvidence(server,{token,platform:'win32',...selection,capture});};
 const config={root,configFile:false,appType:'custom',logLevel:'silent',plugins:[{name:'component-owned-window-route',configureServer:install,configurePreviewServer:install}]};
 const server=mode==='preview'?await preview({...config,build:{outDir:p.join(root,'assets')},preview:{host:'127.0.0.1',port:0}}):await createServer({...config,server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
 if(mode!=='preview')await server.listen();
 const address=server.httpServer.address();expect(address&&typeof address!=='string').toBe(true);
 const origin=`http://127.0.0.1:${address.port}`,href=client==='package'?`http://tauri.localhost/fixture?reportOrigin=${encodeURIComponent(origin)}`:origin+'/fixture';
 const url=new URL(nativePackageEndpoint(`/__native-window-evidence/${token}`,href),origin).href;
 return{attached,url,close:()=>mode==='preview'?closeNativeValidationServer(server.httpServer):server.close()};
}

it.each(['preview','development'].flatMap(mode=>['windowsPowerShell','powerShell7'].flatMap(nativeP3=>['relative','package'].map(client=>[mode,nativeP3,client]))))('serves the owned POST for %s/%s/%s without native-jobs and preserves method/token/single-use fences',async(mode,nativeP3,client)=>{
 let calls=0;const app=await fixture(mode,{nativeP3},async()=>{calls++;return JSON.stringify({componentOnly:true});},client);
 try{
  expect(app.attached).toBe(true);
  expect((await fetch(app.url)).status).toBe(405);
  expect((await fetch(app.url+'-wrong',{method:'POST'})).status).toBe(404);
  const result=await fetch(app.url,{method:'POST'});expect(result.status).toBe(200);expect(result.headers.get('content-type')).toContain('application/json');expect(await result.json()).toEqual({componentOnly:true});
  expect((await fetch(app.url,{method:'POST'})).status).toBe(500);expect(calls).toBe(1);
 }finally{await app.close();}
},20000);

it.each(['preview','development'])('retains the existing native-jobs route in %s',async mode=>{
 const app=await fixture(mode,{windowsShell:'windowsPowerShell'},async()=>'{}');
 try{expect(app.attached).toBe(true);expect((await fetch(app.url,{method:'POST'})).status).toBe(200);}finally{await app.close();}
},20000);

it.each([{platform:'linux',nativeP3:'powerShell7'},{nativeP3:'zsh'},{}])('keeps capture unavailable outside an admitted Windows provider: %j',async selection=>{
 let calls=0;const app=await fixture('preview',selection,async()=>{calls++;return '{}';});
 try{expect(app.attached).toBe(false);expect((await fetch(app.url,{method:'POST'})).status).toBe(404);expect(calls).toBe(0);}finally{await app.close();}
},20000);

it('propagates the real capture callback refusal through HTTP without returning success metadata',async()=>{
 const app=await fixture('preview',{nativeP3:'windowsPowerShell'},async()=>{throw Error('COMPONENT_ONLY_OWNED_CAPTURE_REFUSAL');});
 try{const result=await fetch(app.url,{method:'POST'});expect(result.status).toBe(500);expect(await result.text()).toContain('COMPONENT_ONLY_OWNED_CAPTURE_REFUSAL');}finally{await app.close();}
},20000);

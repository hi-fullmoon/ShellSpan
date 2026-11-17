import assert from 'node:assert/strict';
import {it} from 'vitest';
import {readFile,mkdir,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {attachDisplayTraceChannel} from '../native-input-p3/display-trace-channel.mjs';

// Observed actual pinned Chromium/WebKit paste, not a Shell/native receipt.
// Original: display-paste-checks/4500b306-e735-4298-bec6-da3bcee329ad/chromium.json.
const captured=await readFile(resolve(import.meta.dirname,'fixtures/public-paste-trace-v5.json'));
async function channel(selection,run){
 const directory=resolve(import.meta.dirname,'../../artifacts/tests/display-trace-channel',randomUUID()),token=randomUUID();await mkdir(directory,{recursive:true,mode:0o700});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-owned-trace-channel',configureServer(server){attachDisplayTraceChannel(server,token,directory,{nativeDaily:selection});}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{await run({directory,url:`http://127.0.0.1:${server.address().port}/__native-display-trace/${token}`});}
 finally{await new Promise(done=>server.close(done));await vite.close();}
}
it('retains exact actual paste-trace request bytes once through the production HTTP channel',async()=>{
 await channel('full-zsh',async({directory,url})=>{
  assert.equal((await fetch(url)).status,405);
  const response=await fetch(url,{method:'POST',body:captured});assert.equal(response.status,200);const saved=await response.json();
  assert.equal(saved.bytes,captured.length);assert.equal(saved.file,resolve(directory,'native-display-trace.json'));assert.equal(saved.sha256,createHash('sha256').update(captured).digest('hex'));assert((await readFile(saved.file)).equals(captured));
  assert.equal((await fetch(url,{method:'POST',body:captured})).status,500);assert((await readFile(saved.file)).equals(captured));
 });
});
it.each([undefined,'raw-zsh','raw-bash','human-zsh','powerShell7'])('rejects version5 outside the exact automatic Mac selection: %s',async selection=>{
 await channel(selection,async({directory,url})=>{assert.equal((await fetch(url,{method:'POST',body:captured})).status,500);await assert.rejects(()=>lstat(resolve(directory,'native-display-trace.json')),{code:'ENOENT'});});
});
it.each(['authority','missing-paste','extra-paste-authority','undrained','unknown-version'])('rejects a mutated observation without retaining a trace: %s',async kind=>{
 const changed=JSON.parse(captured),paste=changed.events[2];
 if(kind==='authority')changed.inputOrLifecycleAuthority=true;
 if(kind==='missing-paste')changed.events.pop();
 if(kind==='extra-paste-authority')paste.action.execute=true;
 if(kind==='undrained')paste.parsedThrough=-1;
 if(kind==='unknown-version')changed.version=6;
 await channel('full-bash',async({directory,url})=>{assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(changed)})).status,500);await assert.rejects(()=>lstat(resolve(directory,'native-display-trace.json')),{code:'ENOENT'});});
});
it.each([2,3])('keeps legacy display version %i bytes and admission unchanged',async version=>{
 const legacy=JSON.parse(captured);legacy.version=version;legacy.events=legacy.events.slice(0,2);const bytes=Buffer.from(JSON.stringify(legacy));
 await channel(undefined,async({url})=>{const response=await fetch(url,{method:'POST',body:bytes});assert.equal(response.status,200);assert((await readFile((await response.json()).file)).equals(bytes));});
});

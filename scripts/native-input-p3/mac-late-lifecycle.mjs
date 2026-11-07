import assert from 'node:assert/strict';
import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export function attachMacLateLifecycle(vite,token,directory) {
 const home=resolve(directory,'home'),release=resolve(home,'lifecycle-late-release'),effect=resolve(home,'lifecycle-late-effect');
 assert(!existsSync(release)&&!existsSync(effect),'Never reuse an old lifecycle gate');
 let reserved=false;
 vite.middlewares.use(`/__native-local-late/${token}`,(request,response)=>{
  void(async()=>{
   response.setHeader('Content-Type','application/json');
   if(request.method==='GET'&&request.url==='/status') {
    let value=null;if(existsSync(effect)){const info=lstatSync(effect);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=64);value=readFileSync(effect,'utf8');}
    response.end(JSON.stringify({released:existsSync(release),effect:value}));return;
   }
   if(request.method!=='POST'||request.url!=='/release'){response.writeHead(405).end(JSON.stringify({error:'Unsupported owned gate request'}));return;}
   if(reserved){response.writeHead(409).end(JSON.stringify({error:'Owned gate is single-use'}));return;}
   reserved=true;const releasedAtUnixMs=Date.now();
   await writeFile(release,'release\n',{flag:'wx',mode:0o600});
   const receipt={releasedAtUnixMs,releaseFile:release,scope:'Gate released once; actual old PTY must still independently emit and confirm its output.'};
   await writeFile(resolve(directory,'late-release-receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
   response.end(JSON.stringify({released:true,releasedAtUnixMs}));
  })().catch(()=>response.writeHead(500).end(JSON.stringify({error:'Owned lifecycle gate failed; no retry authorized'})));
 });
}

import {mkdirSync,readFileSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {request} from 'node:http';
import {createServer} from 'vite';
import {expect,it} from 'vitest';
import {attachMacLateLifecycle} from '../native-input-p3/mac-late-lifecycle.mjs';

it('releases the actual owned file once and never invents an old-program effect',async()=>{
 const directory=resolve(import.meta.dirname,'../../.artifacts/tests/native-input-p3/late-channel',randomUUID());
 mkdirSync(resolve(directory,'home'),{recursive:true,mode:0o700});
 const token=randomUUID(),server=await createServer({configFile:false,root:directory,cacheDir:resolve(directory,'vite-cache'),
  logLevel:'silent',appType:'custom',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,watch:null}});
 attachMacLateLifecycle(server,token,directory);
 try {
  await server.listen();const address=server.httpServer.address();expect(address&&typeof address==='object').toBe(true);
  const call=(path,method='GET')=>new Promise((done,reject)=>{const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers:{Connection:'close'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>done({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end();});
  const base=`/__native-local-late/${token}`;
  expect((await call(`/__native-local-late/${randomUUID()}/release`,'POST')).status).toBe(404);
  expect(JSON.parse((await call(base+'/status')).body)).toEqual({released:false,effect:null});
  expect((await call(base+'/release')).status).toBe(405);
  const before=Date.now(),released=await call(base+'/release','POST');expect(released.status).toBe(200);
  const receipt=JSON.parse(released.body);expect(receipt.releasedAtUnixMs).toBeGreaterThanOrEqual(before);
  expect(receipt.releasedAtUnixMs).toBeLessThanOrEqual(Date.now());
  const file=resolve(directory,'home/lifecycle-late-release');expect(readFileSync(file,'utf8')).toBe('release\n');
  if(process.platform!=='win32')expect(statSync(file).mode&0o777).toBe(0o600);
  expect((await call(base+'/release','POST')).status).toBe(409);
  expect(readFileSync(file,'utf8')).toBe('release\n');
  expect(JSON.parse((await call(base+'/status')).body)).toEqual({released:true,effect:null});
  expect(JSON.parse(readFileSync(resolve(directory,'late-release-receipt.json'),'utf8')).releasedAtUnixMs).toBe(receipt.releasedAtUnixMs);
 }finally{await server.close();}
});

import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {request} from 'node:http';
import {createServer} from 'vite';
import {expect,it} from 'vitest';
import {macRawAdmission,attachMacRawAdmission} from '../native-input/acceptance/mac-raw-admission.mjs';
const directory=resolve(import.meta.dirname,'../../artifacts/tests/native-input/acceptance/raw-admission-selection',randomUUID());
const paths={evidence:directory,home:resolve(directory,'home'),data:resolve(directory,'data')};for(const p of [paths.home,paths.data])mkdirSync(p,{recursive:true,mode:0o700});
const localIt=process.platform==='darwin'&&process.arch==='arm64'?it:it.skip;
it('leaves other validation modes unchanged',()=>{expect(macRawAdmission({},paths)).toBeUndefined();});
localIt('requires actual-model family and exact isolated data paths',()=>{
 expect(macRawAdmission({'native-raw-admission':'bash','data-scope':'com.shellspan.validation.native-input-p2'},paths)).toBe('bash');
 expect(macRawAdmission({'native-raw-admission':'zsh','data-scope':'com.shellspan.validation.native-input-p3'},paths)).toBe('zsh');
});
localIt.each([{'no-model':true},{'native-input-p2':true},{'data-scope':'com.shellspan.validation.native-input-p3'},{'native-raw-admission':'other'}])('rejects mixed raw-negative mode: %j',extra=>{
 expect(()=>macRawAdmission({'native-raw-admission':'bash','data-scope':'com.shellspan.validation.native-input-p2',...extra},paths)).toThrow('no mixed operation');
});
it('serves a real read-only owned witness without creating an effect',async()=>{
 const token=randomUUID(),server=await createServer({configFile:false,root:directory,cacheDir:resolve(directory,'vite-cache'),logLevel:'silent',appType:'custom',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,watch:null}});
 attachMacRawAdmission(server,token,directory);
 try{await server.listen();const address=server.httpServer.address();expect(address&&typeof address==='object').toBe(true);
  const call=method=>new Promise((done,reject)=>{const req=request({host:'127.0.0.1',port:address.port,path:`/__native-raw-admission/${token}/status`,method,headers:{Connection:'close'}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>done({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end();});
  const value=await call('GET');expect(value.status).toBe(200);expect(JSON.parse(value.body)).toEqual({home:paths.home,effectPath:resolve(paths.home,'raw-agent-effect'),effectPresent:false});
  expect((await call('POST')).status).toBe(405);expect(JSON.parse((await call('GET')).body).effectPresent).toBe(false);
 }finally{await server.close();}
});

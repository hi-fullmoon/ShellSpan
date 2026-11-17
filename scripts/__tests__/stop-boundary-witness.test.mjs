import {describe,it,expect} from 'vitest';import {createServer} from 'node:http';import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {createStopBoundaryWitness} from '../native-input-p3/stop-boundary-witness.mjs';
describe('stop boundary witness support (not native proof)',()=>{
 it.each(['armed','beforeAccept','afterAccept'])('requires a stopped-case record and resumes the same owned %s gate once',async(stage)=>{
  const owned=resolve('artifacts/tests/stop-boundary-witness');await mkdir(owned,{recursive:true});const evidence=await mkdtemp(join(owned,'case-')),home=join(evidence,'home');await mkdir(home);const token='12345678-1234-1234-1234-123456789abc';
  const handler=await createStopBoundaryWitness({ownedRoot:owned,evidence,home,token,selection:stage+'-takeover'}),server=createServer((req,res)=>{void handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const url='http://127.0.0.1:'+server.address().port,state=await(await fetch(url)).json();expect(state).toMatchObject({armed:false,held:false,stage,action:'takeover',entries:[]});expect((await fetch(url+'/release',{method:'POST'})).status).toBe(409);
   await writeFile(join(evidence,'native-webview-evidence.json'),JSON.stringify({kind:'actual-native-stop-boundary-stopped',token,stopAttempted:true,blockedQueries:[{},{},{}]}));expect((await fetch(url+'/release',{method:'POST'})).status).toBe(200);expect(await readFile(join(evidence,'release-stop-boundary-'+token+'.txt'),'utf8')).toBe('release');expect((await fetch(url+'/release',{method:'POST'})).status).toBe(409);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 it('rejects unsupported stages before creating an action endpoint',async()=>{await expect(createStopBoundaryWitness({ownedRoot:resolve('artifacts/tests'),evidence:resolve('artifacts/tests'),home:resolve('artifacts/tests/home'),token:'12345678-1234-1234-1234-123456789abc',selection:'running-takeover'})).rejects.toThrow();});
});

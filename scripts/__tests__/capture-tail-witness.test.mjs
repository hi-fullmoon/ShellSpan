import {afterEach,describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCaptureTailWitness} from '../native-input-p3/capture-tail-witness.mjs';
const servers=[];afterEach(async()=>{for(const server of servers.splice(0))await new Promise(resolve=>server.close(resolve));});
describe('owned capture-tail witness (unit support only)',()=>{
 it('requires retained unknown observation and releases the owned gate once',async()=>{
  const owned=resolve('artifacts/tests/capture-tail-witness');await mkdir(owned,{recursive:true});const directory=await mkdtemp(join(owned,'case-')),library=join(directory,'fixture.dll'),token='12345678-1234-1234-1234-123456789abc';
  // Hash-only data fixture, never loaded/executed as a DLL or native proof.
  await writeFile(library,'unit-data');const librarySha256=createHash('sha256').update('unit-data').digest('hex');
  const handler=await createCaptureTailWitness({ownedRoot:owned,evidence:directory,token,library,librarySha256}),server=createServer((req,res)=>{void handler(req,res);});servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,url=`http://127.0.0.1:${port}`;
  expect((await fetch(url+'/release',{method:'POST'})).status).toBe(409);
  const state=await(await fetch(url)).json();expect(state.armed).toBe(false);expect(state.librarySha256).toBe(librarySha256);expect(state.eof).toBe(false);
  await writeFile(join(directory,'native-webview-evidence.json'),JSON.stringify({kind:'actual-native-capture-tail-unknown',token,originalToolUnknown:true,capture:{nativeFenceRegistered:true,captureOpen:true,nativeFenceComplete:false}}));
  expect((await fetch(url+'/release',{method:'POST'})).status).toBe(200);expect(await readFile(join(directory,`release-capture-tail-${token}.txt`),'utf8')).toBe(`release:${token}`);expect((await fetch(url+'/release',{method:'POST'})).status).toBe(409);
 });
 it('rejects a mismatched fixture digest before serving anything',async()=>{
  const owned=resolve('artifacts/tests/capture-tail-witness');await mkdir(owned,{recursive:true});const directory=await mkdtemp(join(owned,'digest-')),library=join(directory,'fixture.dll');await writeFile(library,'unit-data');
  await expect(createCaptureTailWitness({ownedRoot:owned,evidence:directory,token:'12345678-1234-1234-1234-123456789abc',library,librarySha256:'0'.repeat(64)})).rejects.toThrow();
 });
});

import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {isMacLocalLifecycle,macLifecycleEvidenceClockEnabled,macLifecycleVisualCheckpoints,macLifecycleSnapshotCheckpoints} from '../native-input/acceptance/mac-local-lifecycle.mjs';
import {attachMacDailyCheckpoints} from '../native-input/acceptance/mac-daily.mjs';

const directory=resolve(import.meta.dirname,'../../artifacts/tests/native-input-p3/local-lifecycle-selection',randomUUID());
const paths={evidence:directory,data:resolve(directory,'data'),home:resolve(directory,'home')};
for(const path of [paths.data,paths.home])mkdirSync(path,{recursive:true,mode:0o700});
const localIt=process.platform==='darwin'&&process.arch==='arm64'?it:it.skip;
const bash={'native-input-p2-lifecycle':true,'native-input-p2':true,'no-model':true,'data-scope':'com.shellspan.validation.native-input-p2'};

it('rejects the late mode alone before any foreground or native operation',()=>{
 const root=resolve(import.meta.dirname,'../..');
 for(const foreground of ['0','1']) {
  const result=spawnSync(process.execPath,['scripts/verification/agent/verify-ai-session-stream.mjs','--native-input-p2-lifecycle-late'],
   {cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:foreground},encoding:'utf8',timeout:5000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain(foreground==='0'?'Native App acceptance is disabled by default':'Late local lifecycle requires the exact owned no-model Mac lifecycle mode');
 }
});

it('rejects dispose alone before any native operation',()=>{
 const root=resolve(import.meta.dirname,'../..');
 for(const foreground of ['0','1']){
  const result=spawnSync(process.execPath,['scripts/verification/agent/verify-ai-session-stream.mjs','--native-input-p2-lifecycle-dispose'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:foreground},encoding:'utf8',timeout:5000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain(foreground==='0'?'Native App acceptance is disabled by default':'Dispose local lifecycle requires the exact owned no-model Mac lifecycle mode without late mode');
 }
});

it('leaves unrelated and SSH lifecycle selection with the existing driver',()=>{
 expect(isMacLocalLifecycle({},paths)).toBe(false);
 expect(isMacLocalLifecycle({...bash,'native-input-p2-ssh-fixture':resolve(directory,'fixture.json')},paths)).toBe(false);
});
localIt('selects only exact no-model local Bash or Zsh families with owned paths',()=>{
 expect(isMacLocalLifecycle(bash,paths)).toBe(true);
 expect(isMacLocalLifecycle({...bash,'native-input-p2-lifecycle-late':true},paths)).toBe(true);
 expect(isMacLocalLifecycle({...bash,'native-input-p2-lifecycle-dispose':true},paths)).toBe(true);
 expect(isMacLocalLifecycle({'native-input-p2-lifecycle':true,'native-input-p3':'zsh','no-model':true,'data-scope':'com.shellspan.validation.native-input-p3'},paths)).toBe(true);
});
localIt.each([
 {'no-model':false},
 {'data-scope':'com.shellspan.validation.native-input-p3'},
 {'native-input-p3':'zsh'},
 {route:'unexpected-route',model:'unexpected-model'},
 {'native-jobs':true},
 {'native-input-p2-lifecycle-late':true,'native-input-p2-lifecycle-dispose':true},
])('rejects mixed or incorrectly scoped local lifecycle arguments: %j',extra=>{
 expect(()=>isMacLocalLifecycle({...bash,...extra},paths)).toThrow('no mixed operation');
});
localIt.each([
 {...paths,data:resolve(directory,'other-data')},
 {...paths,home:resolve(directory,'other-home')},
 {evidence:'relative',data:'relative/data',home:'relative/home'},
])('rejects non-owned local data or home pairs',invalid=>{
 expect(()=>isMacLocalLifecycle(bash,invalid)).toThrow('exact data/HOME');
});

it('leaves the original lifecycle work clock unchanged unless its exact local mode explicitly opts in',()=>{
 expect(macLifecycleEvidenceClockEnabled(false,{})).toBe(false);expect(macLifecycleEvidenceClockEnabled(true,{})).toBe(false);
 for(const value of ['0','true','',undefined]){
  if(value!==undefined)expect(()=>macLifecycleEvidenceClockEnabled(true,{SHELLSPAN_ACCEPTANCE_LIFECYCLE_EVIDENCE_CLOCK:value})).toThrow('explicit isolated macOS');
 }
 expect(()=>macLifecycleEvidenceClockEnabled(false,{SHELLSPAN_ACCEPTANCE_LIFECYCLE_EVIDENCE_CLOCK:'1'})).toThrow('explicit isolated macOS');
 if(process.platform==='darwin'&&process.arch==='arm64')expect(macLifecycleEvidenceClockEnabled(true,{SHELLSPAN_ACCEPTANCE_LIFECYCLE_EVIDENCE_CLOCK:'1'})).toBe(true);
 else expect(()=>macLifecycleEvidenceClockEnabled(true,{SHELLSPAN_ACCEPTANCE_LIFECYCLE_EVIDENCE_CLOCK:'1'})).toThrow('explicit isolated macOS');
});

it('archives actual lifecycle HTTP bytes once while refusing human/EOF labels and creating no image receipt',async()=>{
 const fs=await import('node:fs/promises'),{createHash}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'artifacts/tests/mac-lifecycle-snapshot-http',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const source=resolve(root,'src/components/terminal/__tests__/mac-late-lifecycle.native.ts'),bytes=await fs.readFile(source);
 const payload=JSON.stringify({kind:'mac-human-capture-snapshot',token,label:'lifecycle-complete',role:'automatic',retentionOnly:true,source,hex:bytes.toString('hex'),scope:'Actual source-byte HTTP archive regression only. No native session, image, clock or human receipt.'});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-lifecycle-http-archive',configureServer(server){attachMacDailyCheckpoints(server,token,directory,undefined,{visualLabels:macLifecycleVisualCheckpoints,snapshotLabels:macLifecycleSnapshotCheckpoints});}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
 try{
  const url=base+'/__native-mac-human-snapshot/'+token+'/lifecycle-complete',response=await fetch(url,{method:'POST',body:payload});expect(response.status).toBe(200);const retained=await response.json();
  expect(retained.sha256).toBe(createHash('sha256').update(payload).digest('hex'));expect(retained.humanReceipt).toBe(false);expect(await fs.readFile(retained.file)).toEqual(Buffer.from(payload));
  expect((await fetch(url,{method:'POST',body:payload})).status).toBe(500);expect(await fs.readFile(retained.file)).toEqual(Buffer.from(payload));
  const closedPayload=JSON.stringify({kind:'mac-human-capture-snapshot',token,label:'lifecycle-failure-closed',role:'automatic',retentionOnly:true,source,hex:bytes.toString('hex'),scope:'Actual source-byte closed-failure HTTP archive regression only; not native EOF or human evidence.'});
  const closedUrl=base+'/__native-mac-human-snapshot/'+token+'/lifecycle-failure-closed',closed=await fetch(closedUrl,{method:'POST',body:closedPayload});expect(closed.status).toBe(200);const closedRecord=await closed.json();
  expect(closedRecord.humanReceipt).toBe(false);expect(closedRecord.sha256).toBe(createHash('sha256').update(closedPayload).digest('hex'));expect(await fs.readFile(closedRecord.file)).toEqual(Buffer.from(closedPayload));
  expect((await fetch(closedUrl,{method:'POST',body:closedPayload})).status).toBe(500);expect(await fs.readFile(closedRecord.file)).toEqual(Buffer.from(closedPayload));
  const disposeSource=resolve(root,'src/components/terminal/__tests__/mac-dispose.native.ts'),disposeBytes=await fs.readFile(disposeSource);
  for(const label of ['dispose-ready','dispose-armed','dispose-disposed','dispose-successor','dispose-complete','dispose-failure','dispose-failure-closed']){
   const body=JSON.stringify({kind:'mac-human-capture-snapshot',token,label,role:'automatic',source:disposeSource,hex:disposeBytes.toString('hex'),scope:'Actual source-byte retention test only; no disposal, native execution, image or human receipt.'}),url=base+'/__native-mac-human-snapshot/'+token+'/'+label;
   const response=await fetch(url,{method:'POST',body});expect(response.status).toBe(200);const retained=await response.json();expect(retained.humanReceipt).toBe(false);expect(retained.sha256).toBe(createHash('sha256').update(body).digest('hex'));expect(await fs.readFile(retained.file)).toEqual(Buffer.from(body));
   expect((await fetch(url,{method:'POST',body})).status).toBe(500);expect(await fs.readFile(retained.file)).toEqual(Buffer.from(body));
  }
  for(const label of ['human-final','eof-ready']){
   expect((await fetch(base+'/__native-mac-human-snapshot/'+token+'/'+label,{method:'POST',body:payload})).status).toBe(500);
   expect((await fetch(base+'/__native-mac-daily-checkpoint/'+token+'/'+label,{method:'POST'})).status).toBe(500);
  }
  for(const name of ['visual-observation-lifecycle-final.json','human-operator-complete.json','native-pty-wire.bin'])await expect(fs.lstat(resolve(directory,name))).rejects.toMatchObject({code:'ENOENT'});
  expect(await fs.readFile(source)).toEqual(bytes);
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);

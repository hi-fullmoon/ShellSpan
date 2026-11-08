import assert from 'node:assert/strict';
import {it as test} from 'vitest';
import {macDailyAcceptance,macDailyAppConfiguration,attachMacDailyCheckpoints} from '../native-input-p3/mac-daily.mjs';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
const values={'native-mac-daily':'zsh','no-model':true,'data-scope':'com.shellspan.validation.native-input-p3'};
const environment={SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:'/owned/case',SHELLSPAN_DATA_DIR:'/owned/case/data',SHELLSPAN_LOCAL_HOME:'/owned/case/home'};
test('daily selector leaves every existing mode alone',()=>assert.equal(macDailyAcceptance({}),undefined));
test('daily selector requires exact owned no-model configuration',()=>{
 if(process.platform==='darwin'&&process.arch==='arm64')for(const family of ['zsh','bash','raw-zsh','raw-bash','editing-zsh','editing-bash','pump-zsh','pump-bash','toast-zsh','toast-bash'])assert.equal(macDailyAcceptance({...values,'native-mac-daily':family},environment),family);
 else assert.throws(()=>macDailyAcceptance(values,environment));
 for(const invalid of [{...values,'no-model':false},{...values,'native-mac-daily':'powerShell7'},{...values,'native-jobs':true},{...values,'data-scope':'com.shellspan-dev'}])assert.throws(()=>macDailyAcceptance(invalid,environment));
 for(const invalid of [{...environment,SHELLSPAN_LOCAL_HOME:'/real/home'},{...environment,SHELLSPAN_DATA_DIR:'/real/data'},{...environment,SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:'relative'}])assert.throws(()=>macDailyAcceptance(values,invalid));
});
test('real checkpoint HTTP abort preserves pending evidence and cannot count as an image observation',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'.artifacts/tests/mac-daily-checkpoints',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'owned-mac-daily-checkpoint-test',configureServer(server){attachMacDailyCheckpoints(server,token,directory);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const result=fetch('http://127.0.0.1:'+server.address().port+'/__native-mac-daily-checkpoint/'+token+'/ready',{method:'POST'});
  const pending=resolve(directory,'visual-pending-ready.json'),deadline=Date.now()+5000;
  for(;;){try{const value=JSON.parse(await fs.readFile(pending,'utf8'));assert.equal(value.token,token);assert.equal(value.humanReceipt,false);break;}catch(error){if(error.code!=='ENOENT')throw error;assert(Date.now()<deadline,'Actual checkpoint request did not create pending evidence');await new Promise(done=>setTimeout(done,10));}}
  await fs.writeFile(resolve(directory,'visual-abort-ready.json'),JSON.stringify({token,label:'ready',automationOnly:true,humanReceipt:false,reason:'Owned unit HTTP barrier explicitly aborted; no App or screenshot claim'}),{flag:'wx',mode:0o600});
  const response=await result;assert.equal(response.status,409);const value=await response.json();assert.equal(value.observed,false);assert.equal(value.aborted,true);assert.equal(value.humanReceipt,false);
  await assert.rejects(()=>fs.lstat(resolve(directory,'visual-observation-ready.json')),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);
test('retains window options and leaves the WebKit identifier to the runtime SDK API',async()=>{
 const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'.artifacts/tests/native-input-p2/window-options-case');
 const token='11111111-2222-4333-8444-555555555555',other='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const base=JSON.parse(readFileSync(resolve(root,'src-tauri/tauri.conf.json'),'utf8')).app.windows;
 const first=await macDailyAppConfiguration(root,directory,token),second=await macDailyAppConfiguration(root,directory,other);
 assert.equal(first.appDirectoriesOverride,resolve(directory,'app-directories'));
 assert.deepEqual(first.windows.map(({dataStoreIdentifier,...window})=>window),base);
 assert.equal(first.windows[0].dataStoreIdentifier,undefined);
 assert.deepEqual(first.windows,second.windows);
 await assert.rejects(()=>macDailyAppConfiguration(root,root,token));
});
test.runIf(process.platform==='darwin'&&process.arch==='arm64')('actual pump evidence endpoint reads once without writing and refuses symbolic links',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const root=resolve(import.meta.dirname,'../..'),base=resolve(root,'.artifacts/tests/mac-daily-pump-http',randomUUID()),source=resolve(root,'src/components/terminal/__tests__/mac-daily-input-plan.ts');
 const cases=[{directory:resolve(base,'regular'),token:randomUUID(),link:false},{directory:resolve(base,'symlink'),token:randomUUID(),link:true}];
 for(const item of cases){await fs.mkdir(resolve(item.directory,'home'),{recursive:true,mode:0o700});const destination=resolve(item.directory,'home','phase2-pump-result');if(item.link)await fs.symlink(source,destination);else await fs.copyFile(source,destination);}
 for(const item of cases){const destination=resolve(item.directory,'data','logs','frontend.log');await fs.mkdir(resolve(item.directory,'data','logs'),{recursive:true,mode:0o700});if(item.link)await fs.symlink(source,destination);else await fs.copyFile(source,destination);}
 const original=await fs.readFile(source),vite=await createViteServer({root:base,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-pump-file-observation',configureServer(server){for(const item of cases)attachMacDailyCheckpoints(server,item.token,item.directory);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=item=>'http://127.0.0.1:'+server.address().port+'/__native-mac-pump-result/'+item.token;
 try{
  const response=await fetch(url(cases[0]));assert.equal(response.status,200);const actual=await response.json();assert.equal(actual.hex,original.toString('hex'));assert.equal(actual.bytes,original.length);assert(actual.readOnly);
  assert.deepEqual(await fs.readFile(resolve(cases[0].directory,'home','phase2-pump-result')),original);assert.deepEqual(await fs.readFile(source),original);
  assert.equal((await fetch(url(cases[0]))).status,500);assert.equal((await fetch(url(cases[1]))).status,500);
  await assert.rejects(()=>fs.stat(resolve(cases[1].directory,'pump-received-bytes.json')),{code:'ENOENT'});
  const logUrl=item=>'http://127.0.0.1:'+server.address().port+'/__native-mac-toast-log/'+item.token;
  const logResponse=await fetch(logUrl(cases[0]));assert.equal(logResponse.status,200);const log=await logResponse.json();assert.equal(log.text,original.toString('utf8'));assert(log.readOnly);assert.deepEqual(await fs.readFile(log.file),original);
  assert.equal((await fetch(logUrl(cases[0]))).status,500);assert.equal((await fetch(logUrl(cases[1]))).status,500);
  await assert.rejects(()=>fs.stat(resolve(cases[1].directory,'toast-frontend-log.bin')),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);

import assert from 'node:assert/strict';
import {it as test} from 'vitest';
import {macDailyAcceptance,macDailyAppConfiguration,attachMacDailyCheckpoints,macHumanFinalEvidenceWindow,macDailyRuntimeTimeoutMilliseconds,macDailyCaptureConfiguration,macSystemSelectionObservationConfiguration,macHumanVisualCheckpoints,macDailyVisualCheckpoints} from '../native-input-p3/mac-daily.mjs';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
const values={'native-mac-daily':'zsh','no-model':true,'data-scope':'com.shellspan.validation.native-input-p3'};
const environment={SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:'/owned/case',SHELLSPAN_DATA_DIR:'/owned/case/data',SHELLSPAN_LOCAL_HOME:'/owned/case/home'};
test('daily selector leaves every existing mode alone',()=>assert.equal(macDailyAcceptance({}),undefined));
test('real human copies retain all six selected-state image barriers without becoming capture-only acceptance',()=>{
 assert.deepEqual(macHumanVisualCheckpoints,['human-ready','human-step-4','human-step-5','human-step-6','human-step-7','human-step-8','human-step-9','human-final']);
 assert.equal(new Set(macHumanVisualCheckpoints).size,8);assert(Object.isFrozen(macHumanVisualCheckpoints));assert(macHumanVisualCheckpoints.every(label=>macDailyVisualCheckpoints.includes(label)));
 for(const selection of ['human-zsh','human-bash','human-copy-zsh','human-copy-bash'])assert.equal(macDailyCaptureConfiguration(selection),undefined);
 assert.equal(macDailyCaptureConfiguration('full-zsh').captureLabels.length,21);
});
test('system mouse/clipboard observations stay isolated from human receipts and capture-only confirmations',()=>{
 for(const selection of ['system-selection-zsh','system-selection-bash']){
  const options=macSystemSelectionObservationConfiguration(selection);assert.equal(options.visualLabels.length,8);assert.equal(options.snapshotLabels.length,9);assert.equal(options.captureLabels,undefined);
  assert.equal(macDailyCaptureConfiguration(selection),undefined);assert.equal(macDailyRuntimeTimeoutMilliseconds(selection),600000);
  if(process.platform==='darwin'&&process.arch==='arm64')assert.equal(macDailyAcceptance({...values,'native-mac-daily':selection},environment),selection);
  for(const invalid of [{...values,'native-mac-daily':selection,'no-model':false},{...values,'native-mac-daily':selection,'native-input-p2-lifecycle':true}])assert.throws(()=>macDailyAcceptance(invalid,environment));
 }
 for(const selection of [undefined,'human-zsh','full-bash','raw-zsh','system-selection-powerShell7'])assert.equal(macSystemSelectionObservationConfiguration(selection),undefined);
});
test('only fixed automatic full/raw cases separate capture from visual acceptance',()=>{
 const full=macDailyCaptureConfiguration('full-zsh');assert.deepEqual(macDailyCaptureConfiguration('full-bash'),full);
 assert.equal(full.captureLabels.length,21);assert.deepEqual(full.liveAuditLabels,['ready','tui-enter','tui-exit']);assert.equal(full.captureLabels.at(-1),'toast-visible');
 assert.deepEqual(macDailyCaptureConfiguration('raw-bash').captureLabels,['ready','tui-enter','tui-edit','tui-exit']);assert.deepEqual(macDailyCaptureConfiguration('raw-zsh'),macDailyCaptureConfiguration('raw-bash'));
 for(const selection of [undefined,'zsh','bash','editing-zsh','pump-bash','toast-zsh','human-zsh','eof-private-zsh','full-powerShell7'])assert.equal(macDailyCaptureConfiguration(selection),undefined);
});
test('actual capture barrier abort preserves a pending capture and grants no visual authority',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const directory=resolve(import.meta.dirname,'../../.artifacts/tests/mac-daily-capture-abort',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-capture-abort',configureServer(server){attachMacDailyCheckpoints(server,token,directory,undefined,macDailyCaptureConfiguration('full-zsh'));}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const request=fetch('http://127.0.0.1:'+server.address().port+'/__native-mac-daily-capture/'+token+'/ready',{method:'POST'}),pendingFile=resolve(directory,'visual-pending-ready.json'),deadline=Date.now()+5000;
  for(;;){try{const pending=JSON.parse(await fs.readFile(pendingFile,'utf8'));assert.equal(pending.token,token);assert.equal(pending.captureOnly,true);assert.equal(pending.visualReviewed,false);assert.equal(pending.humanReceipt,false);break;}catch(error){if(error.code!=='ENOENT')throw error;assert(Date.now()<deadline);await new Promise(done=>setTimeout(done,10));}}
  await fs.writeFile(resolve(directory,'visual-abort-ready.json'),JSON.stringify({token,label:'ready',automationOnly:true,humanReceipt:false,reason:'Actual HTTP capture request aborted without any image, App or visual result'}),{flag:'wx',mode:0o600});
  const response=await request;assert.equal(response.status,409);const value=await response.json();assert.equal(value.captured,false);assert.equal(value.visualReviewed,false);assert.equal(value.acceptancePassed,false);assert.equal(value.humanReceipt,false);
  for(const name of ['visual-ready.png','visual-capture-ready.json','visual-observation-ready.json','native-webview-evidence.json'])await assert.rejects(()=>fs.stat(resolve(directory,name)),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);
test('legacy standalone capture requests are disabled before a pending file can be created',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const directory=resolve(import.meta.dirname,'../../.artifacts/tests/mac-daily-capture-disabled',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-disabled-capture',configureServer(server){attachMacDailyCheckpoints(server,token,directory);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/__native-mac-daily-capture/'+token+'/ready',{method:'POST'});assert.equal(response.status,500);
  await assert.rejects(()=>fs.stat(resolve(directory,'visual-pending-ready.json')),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);
test('only new full daily cases use the predeclared combined runtime deadline',()=>{
 for(const family of ['full-zsh','full-bash'])assert.equal(macDailyRuntimeTimeoutMilliseconds(family),1200000);
 for(const family of [undefined,'zsh','bash','raw-zsh','raw-bash','editing-zsh','pump-bash','toast-bash','eof-private-zsh'])assert.equal(macDailyRuntimeTimeoutMilliseconds(family),600000);
});
test('human final evidence waiting never changes the original operator completion limit',()=>{
 const startedAt=1000000,evidence={kind:'mac-human-operator-complete',trusted:true,operatorStartedAt:startedAt,operatorCompletedAt:startedAt+900000};
 const valid={operatorCompleted:true,evidence},window=macHumanFinalEvidenceWindow(startedAt,valid);
 assert.equal(window.phase,'operator-complete');assert.equal(window.operatorTimerStarted,false);assert.equal(window.evidenceTimerStarted,false);
 for(const change of [{operatorCompletedAt:startedAt+900001},{operatorCompletedAt:startedAt-1},{operatorStartedAt:startedAt-1},{trusted:false},{kind:'manual-native-display-ready'}])assert.throws(()=>macHumanFinalEvidenceWindow(startedAt,{...valid,evidence:{...evidence,...change}}));
 assert.throws(()=>macHumanFinalEvidenceWindow(undefined,valid));assert.throws(()=>macHumanFinalEvidenceWindow(startedAt,{...valid,operatorCompleted:false}));
});
test('daily selector requires exact owned no-model configuration',()=>{
 if(process.platform==='darwin'&&process.arch==='arm64')for(const family of ['zsh','bash','full-zsh','full-bash','raw-zsh','raw-bash','editing-zsh','editing-bash','pump-zsh','pump-bash','toast-zsh','toast-bash','human-zsh','human-bash','human-copy-zsh','human-copy-bash','eof-zsh','eof-bash','eof-natural-zsh','eof-natural-bash','eof-private-zsh','eof-private-bash','eof-owned-zsh','eof-owned-bash'])assert.equal(macDailyAcceptance({...values,'native-mac-daily':family},environment),family);
 else assert.throws(()=>macDailyAcceptance(values,environment));
 for(const invalid of [{...values,'no-model':false},{...values,'native-mac-daily':'powerShell7'},{...values,'native-jobs':true},{...values,'data-scope':'com.shellspan-dev'}])assert.throws(()=>macDailyAcceptance(invalid,environment));
 for(const invalid of [{...environment,SHELLSPAN_LOCAL_HOME:'/real/home'},{...environment,SHELLSPAN_DATA_DIR:'/real/data'},{...environment,SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:'relative'}])assert.throws(()=>macDailyAcceptance(values,invalid));
 for(const family of ['full-zsh','full-bash']){
  const selected={...values,'native-mac-daily':family};
  for(const invalid of [{...selected,'no-model':false},{...selected,'native-input-p2-lifecycle':true},{...selected,'data-scope':'com.shellspan-dev'}])assert.throws(()=>macDailyAcceptance(invalid,environment));
  assert.throws(()=>macDailyAcceptance(selected,{...environment,SHELLSPAN_LOCAL_HOME:'/real/home'}));
 }
 const selection={...values,'native-mac-daily':'human-selection-zsh'};
 if(process.platform==='darwin'&&process.arch==='arm64')assert.equal(macDailyAcceptance(selection,environment),'human-selection-zsh');
 else assert.throws(()=>macDailyAcceptance(selection,environment));
 for(const invalid of [{...selection,'no-model':false},{...selection,'native-mac-daily':'human-selection-bash'},{...selection,'data-scope':'com.shellspan-dev'},{...selection,'extra':true}])assert.throws(()=>macDailyAcceptance(invalid,environment));
 assert.throws(()=>macDailyAcceptance(selection,{...environment,SHELLSPAN_LOCAL_HOME:'/real/home'}));
});
test('actual automatic daily archive retains original bytes once without a completion receipt',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID,createHash}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const directory=resolve(import.meta.dirname,'../../.artifacts/tests/mac-daily-snapshot-http',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const source=resolve(import.meta.dirname,'../../src/components/terminal/__tests__/mac-wire-capture.ts'),original=await fs.readFile(source);
 const body=JSON.stringify({kind:'mac-human-capture-snapshot',token,label:'daily-final',role:'automatic',humanReceipt:false,scope:'Actual file bytes for HTTP retention only; no native transport, execution or visual claim.',source,hex:original.toString('hex')});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-daily-wire-archive',configureServer(server){attachMacDailyCheckpoints(server,token,directory);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const url='http://127.0.0.1:'+server.address().port+'/__native-mac-human-snapshot/'+token+'/daily-final';
  const response=await fetch(url,{method:'POST',body});assert.equal(response.status,200);const record=await response.json();assert.equal(record.humanReceipt,false);assert.equal(record.sha256,createHash('sha256').update(body).digest('hex'));assert.deepEqual(await fs.readFile(record.file),Buffer.from(body));
  assert.equal((await fetch(url,{method:'POST',body})).status,500);assert.deepEqual(await fs.readFile(record.file),Buffer.from(body));assert.deepEqual(await fs.readFile(source),original);
  for(const name of ['visual-observation-daily-final.json','human-operator-complete.json','native-webview-evidence.json'])await assert.rejects(()=>fs.stat(resolve(directory,name)),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);
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
 const submission=await macDailyAppConfiguration(root,directory,token,{submission:true});
 assert.equal(submission.appDirectoriesOverride,undefined);
 assert.deepEqual(submission.windows,first.windows.map(window=>({...window,focus:false})));
 await assert.rejects(()=>macDailyAppConfiguration(root,root,token));
});
test('actual human checkpoint HTTP archive preserves bytes once and grants no visual or human receipt',async()=>{
 const fs=await import('node:fs/promises'),{randomUUID,createHash}=await import('node:crypto'),{createServer}=await import('node:http'),{createServer:createViteServer}=await import('vite');
 const directory=resolve(import.meta.dirname,'../../.artifacts/tests/mac-human-snapshot-http',randomUUID()),token=randomUUID();await fs.mkdir(directory,{recursive:true,mode:0o700});
 const source=resolve(import.meta.dirname,'../../package.json'),sourceBytes=await fs.readFile(source);
 const body=JSON.stringify({kind:'mac-human-capture-snapshot',token,label:'human-final',scope:'HTTP retention regression only. Payload is actual source file bytes, not a native execution, user action or screenshot.',retentionProbe:{source,hex:sourceBytes.toString('hex')}});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-human-snapshot-retention',configureServer(server){attachMacDailyCheckpoints(server,token,directory);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const url='http://127.0.0.1:'+server.address().port+'/__native-mac-human-snapshot/'+token+'/human-final';
 try{
  const response=await fetch(url,{method:'POST',body});assert.equal(response.status,200);const retained=await response.json();
  assert.equal(retained.humanReceipt,false);assert.equal(retained.sha256,createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(await fs.readFile(retained.file),Buffer.from(body));assert.deepEqual(await fs.readFile(source),sourceBytes);
  assert.equal((await fetch(url,{method:'POST',body})).status,500);assert.deepEqual(await fs.readFile(retained.file),Buffer.from(body));
  for(const name of ['visual-observation-human-final.json','human-operator-complete.json','native-pty-wire.bin'])await assert.rejects(()=>fs.stat(resolve(directory,name)),{code:'ENOENT'});
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);
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

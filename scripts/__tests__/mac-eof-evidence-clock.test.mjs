import assert from 'node:assert/strict';
import {it as test} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {createMacEofEvidenceClock} from '../native-input/acceptance/mac-eof-evidence-clock.mjs';
import {attachMacDailyCheckpoints} from '../native-input/acceptance/mac-daily.mjs';

test('actual elapsed work stays cumulative across bounded image waits',async()=>{
 let expire;const expired=new Promise(done=>{expire=done;}),transitions=[];
 const clock=createMacEofEvidenceClock({workMs:900,observationMs:2000,onTimeout:expire,onTransition:value=>transitions.push(value)});
 try{
  clock.start();await delay(250);assert.equal(clock.beginObservation('eof-ready'),true);
  const firstRemaining=clock.snapshot().remainingWorkMs;await delay(350);assert.equal(clock.endObservation('eof-ready'),true);
  await delay(250);assert.equal(clock.beginObservation('eof-closed'),true);
  assert(clock.snapshot().remainingWorkMs<firstRemaining-200,'Work elapsed between image waits must be charged');
  await delay(350);assert.equal(clock.endObservation('eof-closed'),true);
  const result=await Promise.race([expired,delay(700).then(()=>{throw Error('Work budget was reset by an image wait');})]);
  assert.equal(result.phase,'work');assert.equal(clock.snapshot().state,'expired');
  assert.equal(transitions.filter(value=>value.state==='observation').length,2);
 }finally{clock.dispose();}
},10000);

test('expired observation cannot resume work or accept a late result',async()=>{
 let expire;const expired=new Promise(done=>{expire=done;});let calls=0;
 const clock=createMacEofEvidenceClock({workMs:2000,observationMs:60,onTimeout:value=>{calls++;expire(value);}});
 try{
  clock.start();assert.equal(clock.beginObservation('eof-ready'),true);
  assert.throws(()=>clock.beginObservation('eof-closed'));
  assert.throws(()=>clock.endObservation('wrong'));
  assert.equal((await expired).phase,'observation');assert.equal(clock.endObservation('eof-ready'),false);
  assert.throws(()=>clock.start());clock.dispose();await delay(80);
  assert.equal(clock.snapshot().state,'expired');assert.equal(calls,1);
 }finally{clock.dispose();}
});

test('real HTTP abort resumes only the remaining work without creating an observation',async()=>{
 const base=resolve(import.meta.dirname,'../../artifacts/tests/mac-eof-evidence-clock');await mkdir(base,{recursive:true});
 const directory=await mkdtemp(resolve(base,'http-')),token=randomUUID();let timeout;
 const clock=createMacEofEvidenceClock({workMs:700,observationMs:3000,onTimeout:value=>{timeout=value;}});
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-eof-evidence-clock-http',configureServer(server){
  attachMacDailyCheckpoints(server,token,directory,label=>{assert.equal(clock.beginObservation(label),true);return()=>clock.endObservation(label);});
 }}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  clock.start();
  const pendingResult=fetch('http://127.0.0.1:'+server.address().port+'/__native-mac-daily-checkpoint/'+token+'/eof-ready',{method:'POST'});
  const deadline=Date.now()+5000;
  while(clock.snapshot().state!=='observation'){assert(Date.now()<deadline,'Actual HTTP observation did not begin');await delay(10);}
  const pending=JSON.parse(await readFile(resolve(directory,'visual-pending-eof-ready.json'),'utf8'));assert.equal(pending.token,token);
  const remaining=clock.snapshot().remainingWorkMs;await delay(850);assert.equal(timeout,undefined);
  assert.equal(clock.snapshot().state,'observation');assert.equal(clock.snapshot().remainingWorkMs,remaining);
  await writeFile(resolve(directory,'visual-abort-eof-ready.json'),JSON.stringify({token,label:'eof-ready',automationOnly:true,humanReceipt:false,reason:'Actual HTTP clock regression ended without any App or image observation'}),{flag:'wx',mode:0o600});
  const response=await pendingResult;assert.equal(response.status,409);assert.equal((await response.json()).observed,false);
  assert.equal(clock.snapshot().state,'work');assert(clock.snapshot().remainingWorkMs<=remaining);
  await assert.rejects(()=>lstat(resolve(directory,'visual-observation-eof-ready.json')),{code:'ENOENT'});
 }finally{clock.dispose();await new Promise(done=>server.close(done));await vite.close();}
},10000);

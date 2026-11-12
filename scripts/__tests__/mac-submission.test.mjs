import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {mkdir,mkdtemp,writeFile,readFile,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {attachMacSubmissionWitness,macSubmissionControlMode,macSubmissionObservationConfiguration} from '../native-input-p3/mac-submission.mjs';
import {macDailyAcceptance} from '../native-input-p3/mac-daily.mjs';

it('admits only owned no-model submission cases without taking a visual or human receipt',()=>{
 const root=resolve('.artifacts/tests/mac-submission-selector');
 const environment={SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:root,SHELLSPAN_DATA_DIR:join(root,'data'),SHELLSPAN_LOCAL_HOME:join(root,'home')};
 for(const selection of ['submission-zsh','submission-bash']){
  const values={'native-mac-daily':selection,'no-model':true,'data-scope':'com.shellspan.validation.native-input-p3'};
  if(process.platform==='darwin'&&process.arch==='arm64')expect(macDailyAcceptance(values,environment)).toBe(selection);
  expect(()=>macDailyAcceptance({...values,'no-model':false},environment)).toThrow();
  expect(()=>macDailyAcceptance({...values,'native-input-p3-cancel':true},environment)).toThrow();
  expect(macSubmissionObservationConfiguration(selection).visualLabels).toEqual([]);
  expect(macSubmissionObservationConfiguration(selection).snapshotLabels).toContain('lifecycle-complete');
 }
 expect(macSubmissionObservationConfiguration('full-zsh')).toBeUndefined();
 expect(macSubmissionControlMode('control-eof')).toEqual({cut:'accept-receipt',scenario:'control-eof'});
 expect(macSubmissionControlMode('transport-disconnect')).toEqual({cut:'accept-receipt',scenario:'transport-disconnect'});
 expect(macSubmissionControlMode('late-started-and-matched-settled')).toEqual({cut:'accept-receipt',scenario:'late-started-and-matched-settled'});
 for(const scenario of ['source-mismatch','plan-mismatch','target-mismatch','unsupported-input-native','permission-mismatch','resource-manifest-mismatch','byte-boundary','raw-admission'])expect(macSubmissionControlMode(scenario)).toEqual({cut:undefined,scenario});
 expect(macSubmissionControlMode('incomplete-proof')).toEqual({cut:'input-in-progress',scenario:'incomplete-proof'});
 expect(macSubmissionControlMode('readonly-query-does-not-authorize')).toEqual({cut:'input-in-progress',scenario:'readonly-query-does-not-authorize'});
 for(const scenario of ['identity-mismatch','complete-identity-submatrix','generation-mismatch'])expect(macSubmissionControlMode(scenario)).toEqual({cut:'arm-identity',scenario});
 expect(macSubmissionControlMode('delegation')).toEqual({cut:undefined,scenario:'delegation'});
 expect(macSubmissionControlMode('human-phase3')).toEqual({cut:undefined,scenario:'human-phase3'});
});

it('retains actual filesystem effect observations and refuses writes and symlink effects over real HTTP',async()=>{
 const base=resolve('.artifacts/tests/mac-submission-witness');await mkdir(base,{recursive:true});const directory=await mkdtemp(join(base,'case-'));
 const home=join(directory,'home');await mkdir(home);const token=randomUUID();
 const file=join(home,'phase3-effects'),linked=await mkdtemp(join(base,'linked-')),other=randomUUID();
 await mkdir(join(linked,'home'));await symlink(file,join(linked,'home','phase3-effects'));
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-submission-witness',configureServer(server){attachMacSubmissionWitness(server,token,directory);attachMacSubmissionWitness(server,other,linked);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const url='http://127.0.0.1:'+server.address().port+'/__native-mac-submission-witness/'+token;
 try{
  const absent=await(await fetch(url)).json();expect(absent.exists).toBe(false);expect(absent.text).toBeNull();
  const text=randomUUID()+'\n';await writeFile(file,text,{flag:'wx',mode:0o600});
  const observed=await(await fetch(url)).json();expect(observed.exists).toBe(true);expect(observed.text).toBe(text);expect(observed.sha256).toBe(createHash('sha256').update(text).digest('hex'));expect(observed.readOnly).toBe(true);
  expect((await fetch(url,{method:'POST',body:'must-not-be-written'})).status).toBe(500);expect(await readFile(file,'utf8')).toBe(text);
  expect((await fetch(url.replace(token,other))).status).toBe(500);expect(await readFile(file,'utf8')).toBe(text);
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);

it.each([{cut:'intent'},{cut:'input-complete',scenario:'input-complete-stop'},{cut:'armed',scenario:'armed-cancel'},{cut:'before-accept',scenario:'before-accept-takeover'},{cut:'prepare',scenario:'app-crash-prepare'},{cut:'key',scenario:'app-crash-key'},{cut:'accept-receipt',scenario:'timeout-unknown-accept'},{cut:'accept-receipt',scenario:'timeout-unknown-accept',settlement:true}])('releases the observed $cut nonce/PID without writing runtime or recovery state',async(configuration)=>{
 // These are control-file inputs for the HTTP guard, not native receipts or App proof.
 const base=resolve('.artifacts/tests/mac-submission-cut-control');await mkdir(base,{recursive:true});const directory=await mkdtemp(join(base,'case-')),token=randomUUID();
 const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'cut-control-files',configureServer(server){attachMacSubmissionWitness(server,token,directory,configuration);}}]});
 const server=createServer(vite.middlewares);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const {settlement}=configuration,route=settlement?'settled-cut':'cut';
 const url='http://127.0.0.1:'+server.address().port+'/__native-mac-submission-'+route+'/'+token;
 try{
  expect((await(await fetch(url)).json()).cut).toBeNull();expect((await fetch(url,{method:'POST',body:'{}'})).status).toBe(500);
  const nonce=randomUUID(),pid=process.pid,marker=join(directory,`submission-${route}-${pid}-${nonce}.json`),release=marker.slice(0,-5)+'.release';
  const fact={version:1,pid,nonce,cut:settlement?'settled-receipt':configuration.cut,identity:{agentSessionId:'filesystem-control-unit'}};
  await writeFile(marker,JSON.stringify({...fact,cut:fact.cut==='intent'?'input-complete':'intent'}),{flag:'wx',mode:0o600});
  expect((await fetch(url)).status).toBe(500);
  expect((await fetch(url,{method:'POST',body:JSON.stringify({nonce,pid})})).status).toBe(500);
  await writeFile(marker,JSON.stringify(fact),{flag:'w',mode:0o600});
  expect((await(await fetch(url)).json()).cut).toEqual(fact);
  const request={version:1,pid,nonce,requestKind:'cancel-token',identity:fact.identity};await writeFile(join(directory,`submission-request-${nonce}-cancel-token.json`),JSON.stringify(request),{flag:'wx',mode:0o600});
  expect((await(await fetch(url)).json()).requests).toEqual([request]);
  expect((await fetch(url,{method:'POST',body:JSON.stringify({nonce:randomUUID(),pid})})).status).toBe(500);
  expect((await fetch(url,{method:'POST',body:JSON.stringify({nonce,pid,identity:'must-not-change'})})).status).toBe(500);
  const accepted=await fetch(url,{method:'POST',body:JSON.stringify({nonce,pid})});expect(accepted.status).toBe(200);expect((await accepted.json()).authority).toBe('test-barrier-only');
  expect(JSON.parse(await readFile(release,'utf8'))).toEqual({nonce,pid});expect(JSON.parse(await readFile(marker,'utf8'))).toEqual(fact);
  expect((await fetch(url,{method:'POST',body:JSON.stringify({nonce,pid})})).status).toBe(500);
 }finally{await new Promise(done=>server.close(done));await vite.close();}
},15000);

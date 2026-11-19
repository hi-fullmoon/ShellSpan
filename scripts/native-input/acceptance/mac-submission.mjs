import assert from 'node:assert/strict';
import {lstat,readFile,readdir,open,link,mkdir,symlink,readlink,writeFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sshNativeCases} from './ssh-recovery-cases.mjs';

const cuts=['intent','input-in-progress','input-complete','armed','before-accept','after-accept'];
const actions=['stop','cancel','takeover'];
export function macSubmissionControlMode(mode){
 if(Object.hasOwn(sshNativeCases,mode))return {cut:sshNativeCases[mode].cut??undefined,scenario:mode};
 if(mode===undefined||mode==='intent')return {cut:mode,scenario:undefined};
 if(mode==='reduced-motion')return {cut:'before-accept',scenario:mode};
 if(/^local-storage-(healthy|missing|read-only|unknown-format|invalid-marker|foreign-namespace|missing-directory|directory-symlink|corrupt-database)$/.test(mode))return {cut:undefined,scenario:mode};
 if(mode==='local-jobs'||/^local-history-(default|small|custom|empty|unset)$/.test(mode))return {cut:undefined,scenario:mode};
 if(['local-file-ownership','local-file-restart-prepare','local-file-restart-verify'].includes(mode))return {cut:undefined,scenario:mode};
 if(['approval-mismatch','expired-or-revoked','source-mismatch','plan-mismatch','target-mismatch','unsupported-input-native','permission-mismatch','resource-manifest-mismatch','experimental-profile','byte-boundary','raw-admission','local-file-chain'].includes(mode))return {cut:undefined,scenario:mode};
 if(['incomplete-proof','readonly-query-does-not-authorize'].includes(mode))return {cut:'input-in-progress',scenario:mode};
 if(['identity-mismatch','complete-identity-submatrix','generation-mismatch'].includes(mode))return {cut:'arm-identity',scenario:mode};
 if(['timeout-unknown-accept','control-eof','transport-disconnect','late-started-and-matched-settled'].includes(mode))return {cut:'accept-receipt',scenario:mode};
 if(['split-and-coalesced','oversized','invalid-json','invalid-utf8','eof-partial-frame'].some(name=>mode==='wire-'+name))return {cut:undefined,scenario:mode};
 if(actions.some(action=>mode==='running-'+action))return {cut:undefined,scenario:mode};
 if(['runtime-multi-agent','close-running-terminal','delegation','human-phase3'].includes(mode))return {cut:undefined,scenario:mode};
 if(mode==='app-crash-intent')return {cut:'intent',scenario:mode};
 const crashCuts={'app-crash-prepare':'prepare','app-crash-proof':'input-complete','app-crash-arm':'armed','app-crash-key':'key'};
 if(Object.hasOwn(crashCuts,mode))return {cut:crashCuts[mode],scenario:mode};
 if(mode==='app-crash-restart')return {cut:undefined,scenario:mode};
 const cut=cuts.find(candidate=>actions.some(action=>mode===candidate+'-'+action));
 assert(cut,'Explicit supported acceptance scenario required');
 return {cut,scenario:mode};
}

export function macSubmissionObservationConfiguration(selection){
 if(!['submission-zsh','submission-bash'].includes(selection))return undefined;
 if(process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO==='human-phase3')return{
  visualLabels:[],snapshotLabels:[],
  captureLabels:['phase3-manual-ready','phase3-manual-contention','phase3-manual-other','phase3-manual-task-switch'],
 };
 const snapshotPrefix=process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO==='local-file-restart-verify'?'scratch-after-restart-snapshot-':undefined;
 return{visualLabels:[],snapshotPrefix,snapshotLabels:['submission-ready','submission-crash-restart-ready','submission-prepared','submission-reduced-motion','submission-settled','submission-duplicates','submission-rejected','submission-failure','lifecycle-failure','lifecycle-complete']};
}

export function macSubmissionPrepareWrite(events, identity) {
 const writes=[];
 for (const [index,event] of events.entries()) {
  if (event.event!=='control-send-attempt') continue;
  const {payload,identity:actual,requestId}=JSON.parse(Buffer.from(event.details.hex,'hex').toString('utf8'));
  if (payload.kind!=='prepareInput'||!isDeepStrictEqual(actual,identity)) continue;
  const returned=events.slice(index+1).find(next=>next.event==='control-send-return'&&next.details.controlId===event.details.controlId);
  assert(returned?.details.ok===true&&returned.details.partialUnknown===false,'Actual PrepareInput write did not complete');
  assert.equal(payload.sourceDigest,createHash('sha256').update(payload.source).digest('hex'));
  writes.push({requestId,sequence:event.sequence,returnSequence:returned.sequence,reducedMotion:payload.reducedMotion,
   utf8Bytes:Buffer.byteLength(payload.source),sourceDigest:payload.sourceDigest});
 }
 assert.equal(writes.length,1,'Expected one complete private PrepareInput write for the held identity');
 return writes[0];
}

/** Reads actual isolated effects only. It never creates a result or receipt. */
export function attachMacSubmissionWitness(server,token,directory,{cut=process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT,scenario=process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO}={}){
 assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)&&isAbsolute(directory));
 const configuration=macSubmissionControlMode(scenario??cut);
 assert(configuration.cut===cut&&configuration.scenario===scenario,'Cut and scenario do not match');
 if(cut==='input-in-progress')server.middlewares.use(`/__native-mac-submission-input-pause/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Input pause observation is read only');
   const file=resolve(directory,'actual-input-pause.json');
   let observation=null;
   try {
    const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384);
    const bytes=await readFile(file,'utf8');
    if(bytes.endsWith('\n'))observation=JSON.parse(bytes);
   } catch(error) { if(error.code!=='ENOENT')throw error; }
   response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify({observation,authority:'process-observation-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 if(scenario==='transport-disconnect')server.middlewares.use(`/__native-mac-submission-transport-loss/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Transport loss observation is read only');
   const readOwned=async name=>{
    const file=resolve(directory,name),info=await lstat(file);
    assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384);
    const bytes=await readFile(file);
    return {file,sha256:createHash('sha256').update(bytes).digest('hex'),data:JSON.parse(bytes)};
   };
   let observation=null;
   try{
    const signaled=await readOwned('owned-shell-disconnect-signal.json');
    const requested=await readOwned('owned-shell-disconnect-request.json');
    assert.deepEqual(signaled.data.request,{file:requested.file,sha256:requested.sha256});
    assert(signaled.data.syscallAccepted===true&&signaled.data.signal==='SIGKILL'
      &&signaled.data.pid===requested.data.worker.pid&&signaled.data.nonce===requested.data.nonce);
    observation={requested:requested.data,signaled:signaled.data};
   }catch(error){if(error.code!=='ENOENT')throw error;}
   response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify({observation,authority:'process-observation-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 if(scenario==='app-crash-restart')server.middlewares.use(`/__native-mac-submission-resume/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Actual crash resume witness is read only');
   const readOwned=async file=>{assert(file.startsWith(directory+'/'));const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=1024*1024);return await readFile(file);};
   const requestFile=resolve(directory,'actual-intent-crash-request.json'),signalFile=resolve(directory,'actual-intent-crash-signal.json');
   const requestBytes=await readOwned(requestFile),requested=JSON.parse(requestBytes),signal=JSON.parse(await readOwned(signalFile));
   assert(signal.syscallAccepted&&signal.signal==='SIGKILL'&&signal.pid===requested.pid&&signal.requestedBeforeSignal.sha256===createHash('sha256').update(requestBytes).digest('hex'));
   const original=await readOwned(requested.originalInvocation.file);
   assert.equal(createHash('sha256').update(original).digest('hex'),requested.originalInvocation.sha256);
   const armed=JSON.parse(original).evidence;assert(armed.kind==='actual-macos-crash-approval-armed'&&armed.approval.sessionId===requested.identity.agentSessionId);
   const outcome=JSON.parse(await readOwned(resolve(directory,'actual-crash-storage-outcome.json')));
   assert(outcome.pid===requested.pid&&outcome.cut===requested.cut);
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({original:armed,identity:requested.identity,cut:requested.cut,afterCrashEffect:outcome.effect,previousAppPid:requested.pid,authority:'crash-observation-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 if(scenario==='local-file-ownership'){
  const fixtures=new Map();
  server.middlewares.use(`/__native-mac-scratch-fixture/${token}`,(request,response)=>{
   void(async()=>{
    assert(request.method==='POST'&&(!request.url||request.url==='/'),'Exact owned scratch fixture endpoint required');
    const chunks=[];let length=0;
    for await(const chunk of request){length+=chunk.length;assert(length<=8192);chunks.push(chunk);}
    const {action,mode,id,target}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(['stage','observe'].includes(action)&&['occupied','symlink'].includes(mode));
    assert(/^phase3-submission-[a-f0-9-]{36}$/.test(id)&&/^[a-f0-9-]{36}$/.test(target?.sessionId));
    const home=resolve(directory,'home');
    const owner={kind:'local',targetId:`terminal-${target.sessionId}`,sessionId:target.sessionId,cwd:home,localRoot:home};
    assert(isDeepStrictEqual(target,owner));
    const key=createHash('sha256').update(JSON.stringify([id,owner])).digest('hex');
    const temporary=resolve(directory,'data/tmp');
    assert((await lstat(temporary)).isDirectory());
    const root=resolve(temporary,key.slice(0,16)),outside=resolve(directory,`scratch-fixture-${mode}`);
    if(action==='stage'){
     assert(!fixtures.has(mode));
     await mkdir(mode==='occupied'?root:outside,{mode:0o700});
     if(mode==='symlink')await symlink(outside,root);
     await writeFile(resolve(mode==='occupied'?root:outside,'phase3-scratch.sh'),`owned ${mode} fixture\n`,{flag:'wx',mode:0o600});
     fixtures.set(mode,key);
    }
    assert.equal(fixtures.get(mode),key);
    const info=await lstat(root);
    assert(mode==='occupied'?info.isDirectory():info.isSymbolicLink()&&await readlink(root)===outside);
    const path=resolve(mode==='occupied'?root:outside,'phase3-scratch.sh');
    const file=await open(path,'r');let digest;
    try{const stat=await file.stat();assert(stat.isFile()&&stat.size<4096);digest={length:stat.size,mode:stat.mode&0o777,sha256:createHash('sha256').update(await file.readFile()).digest('hex')};}finally{await file.close();}
    const records=await readdir(resolve(directory,'data/agent-runtime/scratch/records'));
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({key,root,mode,path,digest,entries:await readdir(mode==='occupied'?root:outside),records}));
   })().catch(error=>response.writeHead(500).end(String(error)));
  });
 }
 if(scenario==='local-file-restart-verify')server.middlewares.use(`/__native-mac-scratch-restart/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Restart evidence is read only');
   const file=await open(resolve(directory,'scratch-before-restart.json'),'r');let evidence;
   try{const stat=await file.stat();assert(stat.isFile()&&stat.size<1024*1024);evidence=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
   assert(evidence.kind==='actual-macos-local-file-restart-prepare'&&evidence.humanReceipt===false);
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify(evidence));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 if(['local-file-chain','local-file-restart-prepare','local-file-restart-verify'].includes(scenario))server.middlewares.use(`/__native-mac-scratch/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Scratch observation is read only');
   const list=async path=>{try{return await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}};
   const read=async file=>{const info=await lstat(file);assert(info.isFile()&&info.size<=1024*1024);const bytes=await readFile(file);return {path:file,content:bytes.toString('utf8'),length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
   const temporary=resolve(directory,'data/tmp'), ownership=resolve(directory,'data/agent-runtime/scratch/records');
   const files=[];
   for(const entry of await list(temporary))if(entry.isDirectory()&&/^[a-f0-9]{16}$/.test(entry.name)){
    try{files.push(await read(resolve(temporary,entry.name,'phase3-scratch.sh')));}catch(error){if(error.code!=='ENOENT')throw error;}
   }
   const records=[];
   for(const entry of await list(ownership))if(entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name)){
    const value=await read(resolve(ownership,entry.name));records.push({file:value.path,sha256:value.sha256,record:JSON.parse(value.content)});
   }
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({files,records,readOnly:true}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 if(/^local-history-(default|small|custom|empty|unset)$/.test(scenario??''))server.middlewares.use(`/__native-mac-history/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'History observation is read only');
   const home=resolve(directory,'home'),plan=JSON.parse(await readFile(resolve(directory,'local-history-plan.json'),'utf8'));
   assert(plan.mode===scenario.slice('local-history-'.length)&&['.bash_history','history'].includes(plan.standard));
   const read=async name=>{
    try{
     const file=resolve(home,name),info=await lstat(file);assert(info.isFile()&&info.size<=1024*1024);
     return await readFile(file,'utf8');
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
   };
   const custom=await read('custom-history'),standard=await read(plan.standard),startup=await read('history-startup');
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({plan,custom,standard,startup,readOnly:true}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 server.middlewares.use(`/__native-mac-submission-witness/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&(!request.url||request.url==='/'),'Submission effect witness is read only');
   const file=resolve(directory,'home','phase3-effects');let bytes;
   try{const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=1024*1024,'Effect must be an owned bounded regular file');bytes=await readFile(file);}
   catch(error){if(error.code!=='ENOENT')throw error;}
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({file,exists:bytes!==undefined,
    text:bytes?new TextDecoder('utf-8',{fatal:true}).decode(bytes):null,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):null,readOnly:true,authority:'filesystem-observation-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 const mountCut=(name,cut,prefix)=>server.middlewares.use(`/__native-mac-submission-${name}/${token}`,(request,response)=>{
  void(async()=>{
   assert(!request.url||request.url==='/','Exact owned cut endpoint required');
   if(!cut){assert(request.method==='GET');response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:false,scenario:scenario??null,authority:'test-barrier-only'}));return;}
   const names=(await readdir(directory)).filter(name=>name.startsWith(prefix)&&/^\d+-[a-f0-9-]+\.json$/.test(name.slice(prefix.length)));assert(names.length<=1,'Ambiguous actual cut owners');
   let fact,file;
   if(names.length){
    file=resolve(directory,names[0]);const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384);
    fact=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(file)));
    assert(fact.version===1&&fact.cut===cut&&Number.isSafeInteger(fact.pid)&&fact.pid>0&&/^[a-f0-9-]{36}$/.test(fact.nonce)&&fact.identity&&typeof fact.identity.agentSessionId==='string','Invalid actual cut record');
   }
   if(request.method==='GET'){
    const requests=[];
    if(fact)for(const kind of ['cancel-token','takeover-owner-validated']){
     const path=resolve(directory,`submission-request-${fact.nonce}-${kind}.json`);
     try{const info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384);const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path)));assert(request.nonce===fact.nonce&&request.pid===fact.pid&&request.requestKind===kind);requests.push(request);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    let cancelWritten=null,prepareWritten=null;
    if(fact&&(fact.cut==='arm-identity'||scenario==='reduced-motion')){
     assert(fact.trace.startsWith(directory+'/native-control-trace-'+fact.pid+'-'));
     const info=await lstat(fact.trace);
     assert(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.size<=64*1024*1024);
     const text=await readFile(fact.trace,'utf8');
     const complete=text.slice(0,text.lastIndexOf('\n')).split('\n').map(line=>JSON.parse(line));
     if(scenario==='reduced-motion')prepareWritten=macSubmissionPrepareWrite(complete,fact.identity);
     else for(const [index,event] of complete.entries()){
      if(event.event!=='control-send-attempt')continue;
      const message=JSON.parse(Buffer.from(event.details.hex,'hex').toString('utf8'));
      if(message.payload.kind!=='cancelDraft'||!isDeepStrictEqual(message.identity,fact.identity))continue;
      const returned=complete.slice(index+1).find(next=>next.event==='control-send-return'&&next.details.controlId===event.details.controlId);
      if(returned?.details.ok===true&&returned.details.partialUnknown===false){
       cancelWritten={requestId:message.requestId,sequence:event.sequence,returnSequence:returned.sequence};
      }
     }
    }
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:true,cut:fact??null,scenario:scenario??null,requests,cancelWritten,prepareWritten,authority:'test-barrier-only'}));return;
   }
   assert(request.method==='POST'&&fact&&file,'A real observed cut is required before release');
   const chunks=[];let length=0;for await(const chunk of request){const bytes=Buffer.from(chunk);length+=bytes.length;assert(length<=4096);chunks.push(bytes);}
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   assert(body.nonce===fact.nonce&&body.pid===fact.pid&&Object.keys(body).sort().join(',')==='nonce,pid','Cut release identity mismatch');
   const release=file.slice(0,-'.json'.length)+'.release',pending=resolve(directory,'submission-release-pending-'+randomUUID());
   const handle=await open(pending,'wx',0o600);try{await handle.writeFile(JSON.stringify({nonce:fact.nonce,pid:fact.pid}));await handle.sync();}finally{await handle.close();}await link(pending,release);
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({released:true,nonce:fact.nonce,pid:fact.pid,authority:'test-barrier-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 mountCut('cut',cut,'submission-cut-');
 if(cut==='accept-receipt')mountCut('settled-cut','settled-receipt','submission-settled-cut-');
}

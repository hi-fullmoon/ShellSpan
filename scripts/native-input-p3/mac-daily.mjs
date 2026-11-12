import assert from 'node:assert/strict';
import {isAbsolute,resolve,relative,sep} from 'node:path';
import {readFile,writeFile,lstat,open,readdir} from 'node:fs/promises';
import {constants,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const macHumanVisualCheckpoints=Object.freeze(['human-ready',...Array.from({length:6},(_,index)=>'human-step-'+(index+4)),'human-final']);
export const macDailyVisualCheckpoints=Object.freeze(['ready','tui-enter','tui-edit','tui-exit','draft-440x320','draft-360x580','draft-1100x650','parked-360','follow-new-output','multiline-before','multiline-edited','completion-expanded','printed-440x320','printed-1100x650','follow-440x320','follow-1100x650','background-440x320','background-ended','pump-cancelled','pump-completion-ended','toast-visible',...macHumanVisualCheckpoints,'eof-ready','eof-armed','eof-closed','eof-private-live']);

const systemSelection=JSON.parse(readFileSync(resolve(import.meta.dirname,'mac-system-selection-configuration.json'),'utf8'));
export function macSystemSelectionObservationConfiguration(selection){
 if(selection!=='system-selection-zsh'&&selection!=='system-selection-bash')return undefined;
 const labels=[systemSelection.readyLabel,...systemSelection.steps.map(step=>step.label),systemSelection.finalLabel];
 return{visualLabels:labels,snapshotLabels:[...labels,'eof-diagnostic']};
}

export function macHumanViewportObservationConfiguration(selection){
 if(selection!=='human-viewport-zsh'&&selection!=='human-viewport-bash')return undefined;
 const visualLabels=['human-ready','human-viewport-parked','human-viewport-narrowed','human-final'];
 return{visualLabels,snapshotLabels:[...visualLabels,'human-deferred','eof-diagnostic']};
}

export function macDailyCaptureConfiguration(selection){
 if(selection==='full-zsh'||selection==='full-bash')return{captureLabels:macDailyVisualCheckpoints.slice(0,21),liveAuditLabels:['ready','tui-enter','tui-exit']};
 if(selection==='raw-zsh'||selection==='raw-bash')return{captureLabels:['ready','tui-enter','tui-edit','tui-exit'],liveAuditLabels:['ready','tui-enter','tui-exit']};
 return undefined;
}

export function macDailyRuntimeTimeoutMilliseconds(selection){
 return selection==='full-zsh'||selection==='full-bash'?1200000:600000;
}

export function macHumanFinalEvidenceWindow(startedAt,value){
 const evidence=value.evidence;
 assert(Number.isSafeInteger(startedAt)&&value.operatorCompleted===true&&evidence?.kind==='mac-human-operator-complete'&&evidence.trusted===true
  &&evidence.operatorStartedAt===startedAt&&Number.isSafeInteger(evidence.operatorCompletedAt)
  &&evidence.operatorCompletedAt>=startedAt&&evidence.operatorCompletedAt-startedAt<=900000,'Human completion requires its original trusted operator window');
 return{phase:'operator-complete',operatorTimerStarted:false,evidenceTimerStarted:false,scope:'Operator actions ended within their original budget. Keep the actual window for independently observed final evidence; no further operator actions are admitted.'};
}

export async function macDailyAppConfiguration(root,directory,token,{submission=false,passiveWindow=false}={}){
 assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)&&isAbsolute(root)&&isAbsolute(directory),'Exact native case identity required');
 assert(relative(root,directory).startsWith(['.artifacts','tests','native-input-p2',''].join(sep)),'Window data must stay in the owned frozen case');
 const base=JSON.parse(await readFile(resolve(root,'src-tauri/tauri.conf.json'),'utf8'));
 const development=JSON.parse(await readFile(resolve(root,'src-tauri/tauri.dev.conf.json'),'utf8'));
 const windows=development.app?.windows??base.app?.windows;
 assert(windows?.length===1&&windows[0].label==='main','One existing native window required');
 return{...(submission?{}:{appDirectoriesOverride:resolve(directory,'app-directories')}),windows:windows.map(window=>({...window,...(submission||passiveWindow?{focus:false}:{})}))};
}

// Automation-only screenshot barrier. It never supplies a human receipt,
// terminal input, native control acknowledgement or acceptance authority.
export function attachMacDailyCheckpoints(server,token,directory,startObservationWait,options={}){
 const visualLabels=options.visualLabels??macDailyVisualCheckpoints;
 const captureLabels=options.captureLabels??[],liveAuditLabels=options.liveAuditLabels??[];
 const captures=new Set();
 const snapshotLabels=options.snapshotLabels??[...macHumanVisualCheckpoints,'human-deferred','eof-ready','eof-armed','eof-closed','eof-diagnostic','eof-private-live','daily-final'];
 const seen=new Set();
 const archived=new Set();
 // Capturing a real window must not wait for a later human/model visual review:
 // naturally running producers and the production Toast keep their real clocks.
 // This endpoint never creates a visual observation or an acceptance receipt.
 server.middlewares.use(`/__native-mac-daily-capture/${token}`,(request,response)=>{
  void(async()=>{
   const label=request.url?.slice(1);
   assert(request.method==='POST'&&captureLabels.includes(label)&&!captures.has(label),'Unknown, disabled or repeated automatic capture');captures.add(label);
   const requestedAt=new Date().toISOString(),pendingFile=resolve(directory,'visual-pending-'+label+'.json');
   await writeFile(pendingFile,JSON.stringify({token,label,requestedAt,automationOnly:true,humanReceipt:false,captureOnly:true,visualReviewed:false}),{flag:'wx',mode:0o600});
   const receiptFile=resolve(directory,'visual-capture-'+label+'.json'),abortFile=resolve(directory,'visual-abort-'+label+'.json');
   const aborted=async()=>{
    try{
     const info=await lstat(abortFile);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<8192);
     const stopped=JSON.parse(await readFile(abortFile,'utf8'));
     assert(stopped.token===token&&stopped.label===label&&stopped.automationOnly===true&&stopped.humanReceipt===false&&typeof stopped.reason==='string'&&stopped.reason.length>0&&stopped.reason.length<=1024,'Invalid owned capture abort');
     assert(Object.keys(stopped).every(key=>['token','label','automationOnly','humanReceipt','reason'].includes(key)),'Capture abort cannot grant visual or acceptance authority');
     response.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({captured:false,aborted:true,visualReviewed:false,acceptancePassed:false,humanReceipt:false,reason:stopped.reason}));return true;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    return false;
   };
   let receipt;
   while(!response.destroyed){
    if(await aborted())return;
    try{const info=await lstat(receiptFile);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<8192);receipt=JSON.parse(await readFile(receiptFile,'utf8'));break;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(done=>setTimeout(done,10));
   }
   if(response.destroyed)return;
   assert(receipt.version===1&&receipt.token===token&&receipt.label===label&&receipt.automationOnly===true&&receipt.humanReceipt===false&&receipt.captured===true&&receipt.visualReviewed===false,'Capture provenance differs');
   const keys=['version','token','label','beforeUnixMs','afterUnixMs','imageSha256','appPid','executable','automationOnly','humanReceipt','captured','visualReviewed','scope'];
   assert(Object.keys(receipt).every(key=>keys.includes(key)),'Capture cannot supply visualPassed or completion authority');
   assert(Number.isSafeInteger(receipt.beforeUnixMs)&&Number.isSafeInteger(receipt.afterUnixMs)&&receipt.beforeUnixMs>=Date.parse(requestedAt)&&receipt.afterUnixMs>=receipt.beforeUnixMs&&receipt.afterUnixMs<=Date.now(),'Actual capture window is invalid');
   assert(/^[a-f0-9]{64}$/.test(receipt.imageSha256)&&Number.isSafeInteger(receipt.appPid)&&receipt.appPid>0,'Actual capture image/process identity missing');
   const processes=(await readdir(directory)).filter(name=>/^native-image-.*-process\.json$/.test(name));assert(processes.length===1,'One actual owned App process required');
   const actual=JSON.parse(await readFile(resolve(directory,processes[0]),'utf8'));
   assert(actual.appPid===receipt.appPid&&actual.executable===receipt.executable&&receipt.executable.startsWith(directory+sep),'Actual capture used a different App');
   const imageFile=resolve(directory,'visual-'+label+'.png'),image=await open(imageFile,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
   try{const info=await image.stat();assert(info.isFile()&&info.size>0&&info.size<=24*1024*1024,'Actual capture must be a bounded original regular file');bytes=await image.readFile();assert(bytes.length===info.size);}finally{await image.close();}
   assert(createHash('sha256').update(bytes).digest('hex')===receipt.imageSha256,'Original capture bytes changed');
   let runtimeAudit;
   if(liveAuditLabels.includes(label)){
    const file=resolve(directory,'runtime-'+label+'-audit.json');let value;
    while(!response.destroyed){if(await aborted())return;try{const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<4*1024*1024);value=JSON.parse(await readFile(file,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(done=>setTimeout(done,10));}
    if(response.destroyed)return;
    assert(value.label===label&&value.processRecord?.appPid===actual.appPid&&value.processRecord.executable===actual.executable&&value.noModel===true&&value.humanReceipt===false,'Actual live audit identity differs');
    assert(value.pending?.file===pendingFile&&value.pending.sha256===createHash('sha256').update(await readFile(pendingFile)).digest('hex'),'Live audit did not observe this exact capture barrier');
    runtimeAudit={file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')};
   }
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({captured:true,visualReviewed:false,acceptancePassed:false,humanReceipt:false,
    label,image:{file:imageFile,sha256:receipt.imageSha256},capture:{file:receiptFile,sha256:createHash('sha256').update(await readFile(receiptFile)).digest('hex')},runtimeAudit,authority:'image-retention-only'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 server.middlewares.use(`/__native-mac-human-snapshot/${token}`,(request,response)=>{
  void(async()=>{
   const label=request.url?.slice(1);
   assert(request.method==='POST'&&snapshotLabels.includes(label)&&!archived.has(label),'Unknown or repeated capture snapshot');
   const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;assert(length<=8*1024*1024,'Human snapshot exceeds bound');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   assert(value.kind==='mac-human-capture-snapshot'&&value.token===token&&value.label===label,'Mismatched human snapshot identity');
   const file=resolve(directory,'human-snapshot-'+label+'.json');await writeFile(file,bytes,{flag:'wx',mode:0o600});archived.add(label);
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),humanReceipt:false,scope:'Retained client checkpoint bytes only. Capture identity, sequence, completeness and visual evidence require separate verification; this endpoint grants no completion authority.'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 server.middlewares.use(`/__native-mac-eof-witness/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET','EOF effect witness is read only');
   const file=resolve(directory,'home','phase2-eof-cancel-'+token);let exists;
   try{const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink(),'EOF effect path is not an owned regular file');exists=true;}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({exists,file,readOnly:true}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 let pumpObserved=false;
 let toastLogObserved=false;
 server.middlewares.use(`/__native-mac-toast-log/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&!toastLogObserved,'Only one actual frontend rejection log observation is admitted');toastLogObserved=true;
   const file=resolve(directory,'data','logs','frontend.log'),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
   try{const info=await handle.stat();assert(info.isFile()&&info.size<=2*1024*1024,'Expected a bounded actual frontend log');bytes=await handle.readFile();}finally{await handle.close();}
   const captured=resolve(directory,'toast-frontend-log.bin');await writeFile(captured,bytes,{flag:'wx',mode:0o600});
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({file:captured,sha256:createHash('sha256').update(bytes).digest('hex'),text:bytes.toString('utf8'),readOnly:true}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 server.middlewares.use(`/__native-mac-pump-result/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='GET'&&!pumpObserved,'Only one actual received-byte observation is admitted');pumpObserved=true;
   const file=resolve(directory,'home','phase2-pump-result'),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
   let bytes;
   try{const info=await handle.stat();assert(info.isFile()&&info.size>0&&info.size<=8192,'Expected a bounded actual regular received-byte file');bytes=await handle.readFile();assert.equal(bytes.length,info.size);}finally{await handle.close();}
   const evidence={file,hex:bytes.toString('hex'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),observedAt:new Date().toISOString(),readOnly:true};
   await writeFile(resolve(directory,'pump-received-bytes.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify(evidence));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 let wireWritten=false;
 server.middlewares.use(`/__native-pty-wire/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='POST'&&!wireWritten,'Only one actual raw PTY capture is admitted');wireWritten=true;
   const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;assert(length<=16*1024*1024,'Raw PTY capture exceeds bound');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks),file=resolve(directory,'native-pty-wire.bin');
   await writeFile(file,bytes,{flag:'wx',mode:0o600});
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),scope:'Actual broker PTY frame payloads before UTF8 decoding; completeness separately checked against raw frame identity, offsets, sequences and EOF.'}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
 server.middlewares.use(`/__native-mac-daily-checkpoint/${token}`,(request,response)=>{
  void(async()=>{
   const label=request.url?.slice(1);assert(request.method==='POST'&&visualLabels.includes(label)&&!seen.has(label),'Unknown or repeated visual checkpoint');seen.add(label);
   const pending=resolve(directory,'visual-pending-'+label+'.json'),receipt=resolve(directory,'visual-observation-'+label+'.json'),abort=resolve(directory,'visual-abort-'+label+'.json');
   await writeFile(pending,JSON.stringify({token,label,requestedAt:new Date().toISOString(),automationOnly:true,humanReceipt:false}),{flag:'wx',mode:0o600});
   const endWait=startObservationWait?.(label);let waitEnded=false;
   const completeWait=()=>{if(waitEnded)return false;waitEnded=true;return endWait?.()??true;};
   try{
   let value;
   while(!response.destroyed){
    try{
     const info=await lstat(abort);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<8192);
     const stopped=JSON.parse(await readFile(abort,'utf8'));
     assert(stopped.token===token&&stopped.label===label&&stopped.automationOnly===true&&stopped.humanReceipt===false&&typeof stopped.reason==='string'&&stopped.reason.length>0&&stopped.reason.length<=1024,'Invalid owned checkpoint abort');
     assert(Object.keys(stopped).every(key=>['token','label','automationOnly','humanReceipt','reason'].includes(key)),'Abort cannot supply image or observation receipts');
     response.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({observed:false,aborted:true,automationOnly:true,humanReceipt:false,reason:stopped.reason}));return;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    try{const info=await lstat(receipt);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<8192);value=JSON.parse(await readFile(receipt,'utf8'));break;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(done=>setTimeout(done,100));
   }
   if(response.destroyed)return;
   assert(value.token===token&&value.label===label&&value.automationOnly===true&&value.humanReceipt===false&&/^[a-f0-9]{64}$/.test(value.imageSha256),'Missing direct automation observation');
   assert(typeof value.visualPassed==='boolean'&&typeof value.notes==='string','Visual result must remain explicit');
   if(!completeWait()){response.writeHead(409).end('Observation expired');return;}
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({observed:true,automationOnly:true,humanReceipt:false,visualPassed:value.visualPassed,notes:value.notes}));
   }finally{if(!waitEnded)completeWait();}
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
}

// A no-model, process-scoped entrance into the existing signed/frozen runner.
export function macDailyAcceptance(values,environment=process.env){
 const family=values['native-mac-daily'];if(family===undefined)return undefined;
 assert(process.platform==='darwin'&&process.arch==='arm64'&&['zsh','bash','full-zsh','full-bash','raw-zsh','raw-bash','editing-zsh','editing-bash','pump-zsh','pump-bash','toast-zsh','toast-bash','submission-zsh','submission-bash','system-selection-zsh','system-selection-bash','human-zsh','human-bash','human-copy-zsh','human-copy-bash','human-selection-zsh','human-viewport-zsh','human-viewport-bash','eof-zsh','eof-bash','eof-natural-zsh','eof-natural-bash','eof-private-zsh','eof-private-bash','eof-owned-zsh','eof-owned-bash'].includes(family)
  &&values['no-model']===true&&values['data-scope']==='com.shellspan.validation.native-input-p3'
  &&isAbsolute(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR??'')
  &&environment.SHELLSPAN_DATA_DIR===resolve(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,'data')
  &&environment.SHELLSPAN_LOCAL_HOME===resolve(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,'home')
  &&Object.keys(values).every(key=>['native-mac-daily','no-model','data-scope'].includes(key)),
  '--native-mac-daily requires an isolated macOS arm64 no-model case and exact data/HOME');
 return family;
}

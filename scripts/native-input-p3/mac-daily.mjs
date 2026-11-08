import assert from 'node:assert/strict';
import {isAbsolute,resolve,relative,sep} from 'node:path';
import {readFile,writeFile,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';

export const macDailyVisualCheckpoints=Object.freeze(['ready','tui-enter','tui-edit','tui-exit','draft-440x320','draft-360x580','draft-1100x650','parked-360','follow-new-output','multiline-before','multiline-edited','completion-expanded','printed-440x320','printed-1100x650','follow-440x320','follow-1100x650','background-440x320','background-ended','pump-cancelled','pump-completion-ended','toast-visible']);

export async function macDailyAppConfiguration(root,directory,token){
 assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)&&isAbsolute(root)&&isAbsolute(directory),'Exact native case identity required');
 assert(relative(root,directory).startsWith(['.artifacts','tests','native-input-p2',''].join(sep)),'Window data must stay in the owned frozen case');
 const base=JSON.parse(await readFile(resolve(root,'src-tauri/tauri.conf.json'),'utf8'));
 const development=JSON.parse(await readFile(resolve(root,'src-tauri/tauri.dev.conf.json'),'utf8'));
 const windows=development.app?.windows??base.app?.windows;
 assert(windows?.length===1&&windows[0].label==='main','One existing native window required');
 return{appDirectoriesOverride:resolve(directory,'app-directories'),windows:windows.map(window=>({...window}))};
}

// Automation-only screenshot barrier. It never supplies a human receipt,
// terminal input, native control acknowledgement or acceptance authority.
export function attachMacDailyCheckpoints(server,token,directory){
 const seen=new Set();
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
   const label=request.url?.slice(1);assert(request.method==='POST'&&macDailyVisualCheckpoints.includes(label)&&!seen.has(label),'Unknown or repeated visual checkpoint');seen.add(label);
   const pending=resolve(directory,'visual-pending-'+label+'.json'),receipt=resolve(directory,'visual-observation-'+label+'.json'),abort=resolve(directory,'visual-abort-'+label+'.json');
   await writeFile(pending,JSON.stringify({token,label,requestedAt:new Date().toISOString(),automationOnly:true,humanReceipt:false}),{flag:'wx',mode:0o600});
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
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({observed:true,automationOnly:true,humanReceipt:false,visualPassed:value.visualPassed,notes:value.notes}));
  })().catch(error=>response.writeHead(500).end(String(error)));
 });
}

// A no-model, process-scoped entrance into the existing signed/frozen runner.
export function macDailyAcceptance(values,environment=process.env){
 const family=values['native-mac-daily'];if(family===undefined)return undefined;
 assert(process.platform==='darwin'&&process.arch==='arm64'&&['zsh','bash','raw-zsh','raw-bash','editing-zsh','editing-bash','pump-zsh','pump-bash','toast-zsh','toast-bash'].includes(family)
  &&values['no-model']===true&&values['data-scope']==='com.shellspan.validation.native-input-p3'
  &&isAbsolute(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR??'')
  &&environment.SHELLSPAN_DATA_DIR===resolve(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,'data')
  &&environment.SHELLSPAN_LOCAL_HOME===resolve(environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,'home')
  &&Object.keys(values).every(key=>['native-mac-daily','no-model','data-scope'].includes(key)),
  '--native-mac-daily requires an isolated macOS arm64 no-model case and exact data/HOME');
 return family;
}

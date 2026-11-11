import assert from 'node:assert/strict';
import {lstat,readFile,readdir,open,link} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const cuts=['intent','input-complete','armed'];
const actions=['stop','cancel','takeover'];
export function macSubmissionControlMode(mode){
 if(mode===undefined||mode==='intent')return {cut:mode,scenario:undefined};
 const cut=cuts.find(candidate=>actions.some(action=>mode===candidate+'-'+action));
 assert(cut,'Explicit supported acceptance scenario required');
 return {cut,scenario:mode};
}

export function macSubmissionObservationConfiguration(selection){
 if(!['submission-zsh','submission-bash'].includes(selection))return undefined;
 return{visualLabels:[],snapshotLabels:['submission-ready','submission-prepared','submission-settled','submission-duplicates','submission-rejected','submission-failure','lifecycle-failure','lifecycle-complete']};
}

/** Reads actual isolated effects only. It never creates a result or receipt. */
export function attachMacSubmissionWitness(server,token,directory,{cut=process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT,scenario=process.env.SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO}={}){
 assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)&&isAbsolute(directory));
 const configuration=macSubmissionControlMode(scenario??cut);
 assert(configuration.cut===cut&&configuration.scenario===scenario,'Cut and scenario do not match');
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
 server.middlewares.use(`/__native-mac-submission-cut/${token}`,(request,response)=>{
  void(async()=>{
   assert(!request.url||request.url==='/','Exact owned cut endpoint required');
   if(!cut){assert(request.method==='GET');response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:false,authority:'test-barrier-only'}));return;}
   const names=(await readdir(directory)).filter(name=>/^submission-cut-\d+-[a-f0-9-]+\.json$/.test(name));assert(names.length<=1,'Ambiguous actual cut owners');
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
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:true,cut:fact??null,scenario:scenario??null,requests,authority:'test-barrier-only'}));return;
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
}

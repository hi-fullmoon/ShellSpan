// Explicitly authorized setup only. Real API key values remain in memory and
// are never part of a validation result, source snapshot or diagnostic error.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const origin='https://api.minimaxi.com';
const service='com.shellspan.dev.ai-provider';
async function bytes(request){const chunks=[];let length=0;try{for await(const part of request){length+=part.length;assert(length<=16384);chunks.push(part);}return Buffer.concat(chunks);}finally{for(const part of chunks)part.fill(0);}}
export function attachCredentialChannel(server,options){
 const {mode,token,runId,directory}=options;
 assert(['source','destination','verify-absence'].includes(mode));for(const value of[token,runId])assert(/^[a-f0-9-]{36}$/.test(value));
 const base=`/__native-p3-credential/${token}`;let received=false,taken=false,payload,receipt;
 const children=new Set();server.httpServer.once('close',()=>{if(payload)payload.fill(0);payload=undefined;for(const child of children)child.kill();});
 if(mode==='destination'){
  const doc=options.routeDocument;assert(doc.routes.length===1);const route=doc.routes[0];
  assert(new URL(route.baseUrl).origin===origin&&route.adapterId==='chat-completions'&&route.presetId==='minimax'&&doc.defaultSelection.routeId===route.id);
 }
 server.middlewares.use((request,response,next)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname;if(!path.startsWith(base+'/')){next();return;}
  response.setHeader('Cache-Control','no-store');
  void(async()=>{
   const action=path.slice(base.length);const json=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));};
   if(action==='/config'&&request.method==='POST'){json({mode,runId,origin,routeId:options.sourceRouteId,expectedReference:options.expectedReference,routeDocument:mode==='destination'?options.routeDocument:undefined});return;}
   if(mode==='verify-absence'&&action==='/absence'&&request.method==='POST'){
    assert(!received);received=true;const raw=await bytes(request);let result;try{result=JSON.parse(raw.toString('utf8'));}finally{raw.fill(0);}
    assert(result.missing===true&&result.reference===options.expectedReference);
    await writeFile(resolve(directory,'credential-normal-api-absence.json'),JSON.stringify({runId,reference:options.expectedReference,missing:true,command:'ai_get_route_api_key',error:'MISSING_CREDENTIAL'}),{flag:'wx',mode:0o600});response.end('ok');return;
   }
   if(mode==='destination'&&action==='/ready'&&request.method==='POST'){
    await writeFile(resolve(directory,'credential-receiver-ready.json'),JSON.stringify({runId,validationNonce:token,port:1432,routeId:options.routeDocument.defaultSelection.routeId}),{flag:'wx',mode:0o600});response.end('ok');return;
   }
   if(mode==='destination'&&action==='/receive'&&request.method==='POST'){
    assert(!received);const value=await bytes(request);assert(value.length>0);new TextDecoder('utf-8',{fatal:true}).decode(value);received=true;payload=value;response.end('ok');return;
   }
   if(mode==='destination'&&action==='/take'&&request.method==='POST'){
    if(!payload){response.writeHead(204).end();return;}assert(!taken);taken=true;const value=payload;payload=undefined;json({secret:new TextDecoder('utf-8',{fatal:true}).decode(value)});value.fill(0);return;
   }
   if(mode==='destination'&&action==='/receipt'&&request.method==='POST'){
    assert(received&&taken&&!receipt);const raw=await bytes(request);const value=JSON.parse(raw.toString('utf8'));raw.fill(0);
    assert(Object.keys(value).every(key=>['runId','reference','readbackMatches'].includes(key))&&value.runId===runId&&/^llm-[a-f0-9-]{36}$/.test(value.reference)&&value.readbackMatches===true);
    const ownership={version:1,runId,reference:value.reference,service,createdBy:'ai_save_routes'};
    await writeFile(resolve(directory,'credential-ownership.json'),JSON.stringify(ownership,null,2),{flag:'wx',mode:0o600});receipt={stored:true,runId,reference:value.reference,service,createdBy:'ai_save_routes',readbackMatches:true};json(receipt);return;
   }
   if(mode==='destination'&&action==='/status'&&request.method==='GET'){json(receipt??{stored:false,runId});return;}
   if(mode==='source'&&action==='/export'&&request.method==='POST'){
    assert(!received);received=true;const value=await bytes(request);assert(value.length>0);
    const destination=options.destination;assert(destination.host==='100.64.0.82'&&destination.user==='zhengbiwen'&&destination.port===1432&&/^[a-f0-9-]{36}$/.test(destination.validationNonce)&&/^D:\/Developer\/ShellSpan-native-input-p3-app-[a-f0-9-]{36}$/.test(destination.remoteRoot));
    try{
    const args=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlias=100.64.0.254','-o','ConnectTimeout=8','zhengbiwen@100.64.0.82',
      `node ${destination.remoteRoot}/scripts/native-input-p3/credential-relay.mjs ${destination.port} ${destination.validationNonce} ${runId}`];
    const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe']});children.add(child);const output=[];let length=0;child.stdout.on('data',part=>{length+=part.length;if(length>4096)child.kill();else output.push(part);});child.stderr.resume();
    const timeout=setTimeout(()=>child.kill('SIGKILL'),60000);child.once('close',()=>{clearTimeout(timeout);children.delete(child);});
    const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});child.stdin.on('error',()=>{});child.stdin.end(value);assert.equal(await completed,0);value.fill(0);
    const result=JSON.parse(Buffer.concat(output).toString('utf8'));assert(result.stored&&result.runId===runId&&result.service===service&&/^llm-[a-f0-9-]{36}$/.test(result.reference));
    const safe={stored:true,runId,reference:result.reference,service,createdBy:'ai_save_routes',readbackMatches:result.readbackMatches===true};assert(safe.readbackMatches);
    await writeFile(resolve(directory,'credential-transfer-receipt.json'),JSON.stringify(safe,null,2),{flag:'wx',mode:0o600});json({stored:true,runId,reference:safe.reference});return;
    }finally{value.fill(0);}
   }
   response.writeHead(404).end();
  })().catch(()=>{if(payload){payload.fill(0);payload=undefined;}if(!response.headersSent)response.writeHead(500);response.end('P3_CREDENTIAL_CHANNEL_FAILED');});
 });
}

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';

export function attachFocusTraceChannel(server,token,directory){
 assert(isAbsolute(directory)&&/^[0-9a-f-]{36}$/.test(token));
 let received=false;
 server.middlewares.use(`/__native-p3-focus-trace/${token}`,(request,response)=>{
  void(async()=>{
   assert(request.method==='POST'&&!received);
   received=true;
   const chunks=[];let length=0;
   for await(const chunk of request){length+=chunk.length;assert(length<=512*1024,'Oversized passive focus diagnostic');chunks.push(chunk);}
   const body=Buffer.concat(chunks),value=JSON.parse(body.toString('utf8'));
   assert(value.version===1&&['contract-complete','failure-before-cleanup'].includes(value.stage));
   assert(Number.isSafeInteger(value.limits.maxEntries)&&value.limits.maxEntries>0&&value.limits.maxEntries<=2048
    &&Number.isSafeInteger(value.limits.maxBytes)&&value.limits.maxBytes>0&&value.limits.maxBytes<=384*1024);
   assert(Array.isArray(value.entries)&&value.entries.length<=value.limits.maxEntries&&Array.isArray(value.states));
   assert(value.states.length<=value.entries.length&&Number.isSafeInteger(value.serializedBytes)
    &&value.serializedBytes>=0&&value.serializedBytes<=value.limits.maxBytes&&typeof value.overflow==='boolean');
   const file='native-p3-focus-trace.json';
   await writeFile(resolve(directory,file),body,{flag:'wx',mode:0o600});
   response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify({file,sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,
    stage:value.stage,firstViolation:Boolean(value.firstViolation),overflow:value.overflow}));
  })().catch(()=>{response.writeHead(500).end('Owned passive focus diagnostic was not saved');});
 });
}

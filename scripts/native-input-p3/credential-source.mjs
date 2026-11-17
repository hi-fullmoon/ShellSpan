// The normal native getter reads only the selected route. Node handles metadata.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {assertNativeGuiAllowed} from '../native-input-p2/gui-lock.mjs';
assertNativeGuiAllowed();
const root=resolve(import.meta.dirname,'../..');
assert(process.platform==='darwin'&&existsSync(resolve(root,'artifacts/tests/native-input-p3/snapshot-index.json')));
const [action,inputPath]=process.argv.slice(2);assert(['prepare','export'].includes(action));
const input=JSON.parse(readFileSync(inputPath,'utf8'));assert(/^[a-f0-9-]{36}$/.test(input.runId));
const directory=action==='prepare'?resolve(root,'artifacts/tests/native-input-p2/credential-source',randomUUID()):input.sourceDirectory;
assert(directory.startsWith(resolve(root,'artifacts/tests/native-input-p2/credential-source')+'/'));
const environment={...process.env,CARGO_INCREMENTAL:'0',SHELLSPAN_DATA_DIR:resolve(directory,'data'),SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:directory,SHELLSPAN_ACCEPTANCE_RUN_ID:input.runId,SHELLSPAN_DEV_SIGNING_KEYCHAIN:resolve(process.env.HOME,'Library/Keychains/login.keychain-db')};
async function run(name,mode,configuration){
 const fd=openSync(resolve(directory,`${name}.log`),'wx',0o600);
 try{const child=spawn(process.execPath,['scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3',...(mode?['--native-input-p3-credential',mode]:[])],{cwd:root,env:environment,stdio:['pipe',fd,fd]});child.stdin.end(configuration?JSON.stringify(configuration):undefined);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,'Actual native credential phase failed; key values are not diagnostics');}finally{closeSync(fd);}
}
if(action==='prepare'){
 mkdirSync(directory,{recursive:true,mode:0o700});const sources=captureValidationSources(root);writeFileSync(resolve(directory,'sources-before.json'),JSON.stringify(sources));
 await run('initialize');
 const path=resolve(process.env.HOME,'.shellspan-dev/shellspan-main.db');assert(existsSync(path));const source=new DatabaseSync(path,{readOnly:true});let raw;
 try{raw=source.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value;}finally{source.close();}
 const document=JSON.parse(raw);const route=document.routes.find(route=>route.id===document.defaultSelection.routeId);
 assert(route&&new URL(route.baseUrl).origin==='https://api.minimaxi.com'&&route.adapterId==='chat-completions'&&route.presetId==='minimax'&&route.auth.kind==='keychain');
 const database=new DatabaseSync(resolve(directory,'data/shellspan-main.db'));
 try{database.exec('BEGIN');const empty=database.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get();assert.equal(JSON.parse(empty.value).routes.length,0);database.prepare("UPDATE preferences SET value=? WHERE key='llm.routes.v1'").run(raw);database.exec('COMMIT');}finally{database.close();}
 const result={runId:input.runId,sourceDirectory:directory,sourceRouteId:route.id,routeSourceSha256:createHash('sha256').update(raw).digest('hex')};writeFileSync(resolve(directory,'source-ready.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}else{
 const prepared=JSON.parse(readFileSync(resolve(directory,'source-ready.json'),'utf8'));assert(prepared.runId===input.runId&&prepared.sourceRouteId===input.sourceRouteId);
 const original=new DatabaseSync(resolve(process.env.HOME,'.shellspan-dev/shellspan-main.db'),{readOnly:true});try{const raw=original.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value;assert.equal(createHash('sha256').update(raw).digest('hex'),prepared.routeSourceSha256,'Source route metadata changed before export');}finally{original.close();}
 assert.deepEqual(captureValidationSources(root),JSON.parse(readFileSync(resolve(directory,'sources-before.json'),'utf8')));
 await run('export','source',{destination:input.destination,sourceRouteId:input.sourceRouteId});
 assert.deepEqual(captureValidationSources(root),JSON.parse(readFileSync(resolve(directory,'sources-before.json'),'utf8')));
 console.log(JSON.stringify({runId:input.runId,sourceDirectory:directory,receipt:resolve(directory,'credential-transfer-receipt.json')}));
}

// Ownership is derived from the actual exclusive database, never a receipt alone.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,sep} from 'node:path';
const [action,directory,runId,originalPath]=process.argv.slice(2);
assert(['baseline','recover'].includes(action)&&/^[a-f0-9-]{36}$/.test(runId));
const root=resolve(directory),path=resolve(root,'data/shellspan-main.db');
assert(path.startsWith(root+sep));
const original=new DatabaseSync(originalPath,{readOnly:true});let originalReferences;
try{const doc=JSON.parse(original.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value);originalReferences=doc.routes.filter(route=>route.auth.kind==='keychain').map(route=>route.auth.reference).sort();}finally{original.close();}
const database=new DatabaseSync(path,{readOnly:true});let raw,pending;
try{raw=database.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value;pending=database.prepare("SELECT key,value FROM preferences WHERE key LIKE 'llm.pendingCredential.%'").all();}finally{database.close();}
const document=JSON.parse(raw);const baselinePath=resolve(root,'credential-baseline.json');
if(action==='baseline'){
 assert(document.routes.length===0&&!document.defaultSelection&&pending.length===0);
 writeFileSync(baselinePath,JSON.stringify({runId,path,routeSha256:createHash('sha256').update(raw).digest('hex'),empty:true,originalReferences},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({empty:true,pending:0,runId}));
}else{
 const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));assert(baseline.runId===runId&&baseline.path===path&&baseline.empty);
 const originalReferencesUnchanged=JSON.stringify(baseline.originalReferences)===JSON.stringify(originalReferences);
 const protectedReferences=new Set([...baseline.originalReferences,...originalReferences]);
 const references=new Map();
 for(const route of document.routes){assert(new URL(route.baseUrl).origin==='https://api.minimaxi.com'&&route.adapterId==='chat-completions'&&route.presetId==='minimax');assert(route.auth.kind==='keychain');references.set(route.auth.reference,{committed:true,routeId:route.id,routeRevision:route.revision});}
 for(const entry of pending){assert(entry.value==='pending');const reference=entry.key.slice('llm.pendingCredential.'.length);references.set(reference,{...references.get(reference),journal:true});}
 assert(references.size<=1,'Only one normal save is authorized per receiver');
 const apiReceiptPath=resolve(root,'credential-ownership.json');const apiReceipt=existsSync(apiReceiptPath)?JSON.parse(readFileSync(apiReceiptPath,'utf8')):undefined;
 if(apiReceipt){assert(apiReceipt.runId===runId&&apiReceipt.createdBy==='ai_save_routes'&&references.has(apiReceipt.reference));}
 const result=[];
 for(const[reference,proof]of references){assert(/^llm-[a-f0-9-]{36}$/.test(reference)&&!protectedReferences.has(reference),'A task reference conflicts with original user credentials; refusing to delete it');
  const ownership={version:1,runId,reference,service:'com.shellspan.dev.ai-provider',createdBy:'ai_save_routes'};
  const file=resolve(root,`credential-recovered-${reference}.json`);if(!existsSync(file))writeFileSync(file,JSON.stringify(ownership,null,2),{flag:'wx',mode:0o600});else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),ownership);
  result.push({file,reference,...proof,normalApiReceipt:apiReceipt?.reference===reference});
 }
 const evidence={runId,path,documentRevision:document.revision,originalReferencesUnchanged,references:result};
 writeFileSync(resolve(root,'credential-recovery.json'),JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
}

// Explicit regression over an actual App's retained progress and trace.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'../../../..'),directory=resolve(process.argv[2]??'');
assert(process.argv.length===3&&directory.includes('/artifacts/tests/native-input-p2/phase2/'),'Supply one actual App capture');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidenceFile=resolve(directory,'native-webview-evidence.json'),traceFile=resolve(directory,'native-display-trace.json');
const evidenceBytes=readFileSync(evidenceFile),traceBytes=readFileSync(traceFile),evidence=JSON.parse(evidenceBytes),trace=JSON.parse(traceBytes);
const source=readFileSync(resolve(import.meta.dirname,'mac-daily-evidence.ts'),'utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const{compactMacDailyRecords}=await import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
const points=trace.events.filter(e=>e.type==='checkpoint'),original=JSON.stringify(evidence.records);
const reference={file:traceFile,sha256:sha(traceBytes)},compact=compactMacDailyRecords(evidence.records,points,reference);
assert.equal(compact.length,evidence.records.length);assert.equal(compact.length,35);
for(const[index,record]of compact.entries()){
 const point=points[record.stateRef.checkpoint];assert.equal(record.state,undefined);assert.equal(record.label,evidence.records[index].label);
 assert.equal(point.stateJson,evidence.records[index].state);assert.equal(sha(Buffer.from(point.stateJson)),record.stateRef.stateSha256);
 assert.deepEqual(record.stateRef.trace,reference);assert.equal(record.stateRef.stateCharacters,point.stateJson.length);assert.equal(record.stateRef.retained,true);
 for(const[key,value]of Object.entries(evidence.records[index]))if(key!=='state')assert.deepEqual(record[key],value,'Non-state evidence changed: '+key);
}
assert.equal(JSON.stringify(evidence.records),original);assert.equal(sha(readFileSync(evidenceFile)),sha(evidenceBytes));assert.equal(sha(readFileSync(traceFile)),sha(traceBytes));
const originalBytes=Buffer.byteLength(JSON.stringify(evidence)),compactBytes=Buffer.byteLength(JSON.stringify({...evidence,records:compact}));
assert(compactBytes<originalBytes-600000&&compactBytes<1024*1024,'Exact state references did not avoid the unchanged transport bound');
const output=resolve(root,'artifacts/tests/mac-daily-evidence',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
writeFileSync(resolve(output,'result.json'),JSON.stringify({at:new Date().toISOString(),evidenceFile,evidenceSha256:sha(evidenceBytes),traceFile,traceSha256:sha(traceBytes),sourceSha256:sha(Buffer.from(source)),records:compact.length,originalBytes,compactBytes,status:'passed',scope:'Exact transformation/reference verification using actual retained App data only. No new App execution, final wire metadata or acceptance pass supplied.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,records:compact.length,originalBytes,compactBytes,status:'passed'}));

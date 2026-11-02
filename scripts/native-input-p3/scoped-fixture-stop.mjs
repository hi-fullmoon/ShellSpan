// Stop only explicitly named task fixtures, retaining all containers/evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const owner=resolve(import.meta.dirname,'../..'),results=[];
for(const argument of process.argv.slice(2)){
 const file=resolve(argument);assert(file.startsWith(resolve(owner,'.native-input-p3/acceptance-source')+'/'));
 const fixture=JSON.parse(readFileSync(file,'utf8'));assert.equal(fixture.container,`shellspan-nip-p3-${fixture.id}`);
 assert.equal(execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p3"}}',fixture.container],{encoding:'utf8'}).trim(),fixture.id);
 const resultFile=resolve(dirname(file),'run-result.json');if(existsSync(resultFile)){const result=JSON.parse(readFileSync(resultFile,'utf8'));assert(result.accountLocked&&result.credentialDeleted&&result.cleanupErrors.length===0);}
 execFileSync('docker',['stop','--timeout','5',fixture.container],{stdio:'pipe'});
 const running=execFileSync('docker',['inspect','--format','{{.State.Running}}',fixture.container],{encoding:'utf8'}).trim();assert.equal(running,'false');
 const result={container:fixture.container,stopped:true,retained:true,explicitOwner:file};writeFileSync(resolve(dirname(file),'stop-result.json'),JSON.stringify(result,null,2),{flag:'wx'});results.push(result);
}
console.log(JSON.stringify({stopped:results.length,results}));

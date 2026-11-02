import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';

const root=resolve(import.meta.dirname,'../..');
const {values,positionals}=parseArgs({allowPositionals:true,options:{case:{type:'string',multiple:true},'list-cases':{type:'boolean'}}});
assert.equal(positionals.length,1,'Provide the owned fixture path');
const fixture=resolve(positionals[0]);
assert(fixture.startsWith(resolve(root,'.artifacts/tests/native-input-p2/ssh')+'/'));
const combinations=[];
for(const version of['4.1','4.4','5.3'])for(const transport of['local','ssh'])for(const scenario of['history-small','history-default','history-custom','history-empty','history-unset','jobs',...(transport==='ssh'?['lifecycle']:[])])combinations.push({version,transport,scenario});
const key=value=>`${value.version}/${value.transport}/${value.scenario}`;
const selection=values.case?new Set(values.case):undefined;
if(selection)assert(selection.size===values.case.length&&[...selection].every(value=>combinations.some(item=>key(item)===value)),'Case selectors must be unique supported version/transport/scenario combinations');
const selected=selection?combinations.filter(value=>selection.has(key(value))):combinations;
if(values['list-cases']){console.log(JSON.stringify({execution:false,fullMatrix:!selection,cases:selected}));process.exit(0);}
const directory=resolve(root,'.artifacts/tests/native-input-p2/app-matrix',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
const steps=[];const failures=[];let current;let interrupted=false;let preparationBlocked=false;
for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;current?.kill(signal);});
let failure;
try{
  for(const {version,transport,scenario} of selected){
    const arguments_=['scripts/native-input-p2/app.mjs',version,transport==='ssh'?fixture:'-',scenario];
    current=spawn(process.execPath,arguments_,{cwd:root,stdio:['ignore','pipe','pipe']});
    let output='';current.stdout.on('data',bytes=>{output+=bytes;});current.stderr.on('data',bytes=>{output+=bytes;});
    const code=await new Promise((resolve,reject)=>{current.once('error',reject);current.once('exit',resolve);});
    steps.push({version,transport,scenario,exitCode:code,output});
    await writeFile(resolve(directory,'summary.json'),JSON.stringify({result:'RUNNING',fullMatrix:!selection,expectedCaseCount:selected.length,steps},null,2));
    console.log(JSON.stringify({version,transport,scenario,exitCode:code}));
    if(code!==0)failures.push({version,transport,scenario,exitCode:code});
    if(code===78){preparationBlocked=true;break;}
    // Cases have independent apps, data, credentials and PTYs. A rejected
    // model request must not prevent checking unrelated target combinations.
    // Never retry that operation or turn its failed result into a pass.
    assert(!interrupted,'Actual app matrix interrupted');
  }
}catch(error){failure=String(error);}
if(failures.length)failure??=`${failures.length} actual app case(s) failed; ${directory}`;
await writeFile(resolve(directory,'summary.json'),JSON.stringify({result:failure?'FAIL':'PASS',fullMatrix:!selection,expectedCaseCount:selected.length,preparationBlocked,scope:selection?'Selected independent cases; not complete matrix':'Complete 39-case native application matrix',steps,failures,failure},null,2));
if(failure)throw new Error(failure);
console.log(JSON.stringify({directory,result:'PASS',steps:steps.length}));

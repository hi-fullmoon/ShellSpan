import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const owner=resolve(import.meta.dirname,'../..');const root=resolve(process.argv[2]??owner);assert(root===owner||root.startsWith(resolve(owner,'artifacts/tests/native-input-p3/acceptance-source')+'/'));const source=resolve(root,'artifacts/tests/native-input-p3/dependencies/zsh-5.9');
const directory=resolve(root,'artifacts/tests/native-input-p3/isolated-zsh-modules',randomUUID());mkdirSync(directory,{recursive:true});
const output=openSync(resolve(directory,'install.log'),'wx');
try{for(const target of['install.modules','install.fns'])execFileSync('make',[target,`DESTDIR=${directory}`],{cwd:source,stdio:['ignore',output,output]});}finally{closeSync(output);}
const modulePath=resolve(directory,'usr/local/lib/zsh/5.9');const shell=resolve(source,'Src/zsh');
const actual=execFileSync(shell,['-f','-c','module_path=("$1" $module_path); zmodload zsh/zle && zmodload zsh/zselect && print -rn -- P3_PAIRED_MODULES','--',modulePath],{encoding:'utf8',timeout:5000});
assert.equal(actual,'P3_PAIRED_MODULES');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const functionPath=resolve(directory,'usr/local/share/zsh/5.9/functions');assert(readFileSync(resolve(functionPath,'add-zsh-hook')).length>0);
const record={kind:'isolated-upstream-main-and-modules-same-build-no-production-binding',directory,modulePath,functionPath,shell,shellSha256:hash(shell),zleSha256:hash(resolve(modulePath,'zsh/zle.so')),configSha256:hash(resolve(source,'config.h'))};
writeFileSync(resolve(directory,'producer.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));

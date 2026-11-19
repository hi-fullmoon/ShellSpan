// Complete task-owned upstream runtime, never a replacement for /bin/zsh.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');assert(process.platform==='darwin'&&process.arch==='arm64');
assert(root.includes('/artifacts/tests/native-input-p3/acceptance-source/')&&JSON.parse(readFileSync(resolve(root,'artifacts/tests/native-input-p3/snapshot-index.json'),'utf8')).root===root,'Candidate production is restricted to a complete isolated P3 source copy');
const directory=resolve(root,'artifacts/tests/native-input-p3/paired-runtime');mkdirSync(directory,{recursive:true});
const prefix=resolve(directory,'install'),source=resolve(directory,'zsh-5.9');
const archive=resolve(process.argv[2]);const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(hash(archive),'9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5');
const fd=openSync(resolve(directory,'build.log'),'wx');
const run=(command,args,cwd=root)=>execFileSync(command,args,{cwd,stdio:['ignore',fd,fd]});
try{
 run('tar',['-xf',archive,'-C',directory]);
 run('./configure',[`--prefix=${prefix}`,'--disable-gdbm','--with-tcsetpgrp','CFLAGS=-O2 -std=gnu89'],source);
 run('cc',['-std=c11','-I',source,'scripts/native-input/acceptance/zsh-build-check.c','-o',resolve(directory,'config-check')]);
 run('make',['-j4'],source);
 for(const target of['install.bin','install.modules','install.fns'])run('make',[target],source);
 const shell=resolve(prefix,'bin/zsh');
 assert.equal(execFileSync(shell,['-f','-c','autoload -Uz add-zsh-hook add-zle-hook-widget; add-zsh-hook precmd true; zmodload zsh/zle; value=$(/usr/bin/printf %s P3_PAIRED); [[ $value == P3_PAIRED ]] && print -rn -- $ZSH_VERSION'],{encoding:'utf8',timeout:5000}),'5.9');
 run('cargo',['build','--locked','--release','--manifest-path','src-tauri/native-input-editors/Cargo.toml','--lib']);
 const module=resolve(directory,'ss_nip.so');
 run('cc',['-std=c11','-DMODULE','-fPIC','-bundle','-undefined','dynamic_lookup','-I',resolve(source,'Src'),'src-tauri/native-input-editors/zle.c','src-tauri/native-input-editors/target/release/libshellspan_native_input_editors.a','-lpthread','-ldl','-lm','-o',module]);
 const id='zsh-5.9-zle-5.9-macos-arm64-native';
 const resources=resolve(root,'artifacts/tests/native-input-p2/resources/native-input');mkdirSync(resolve(resources,id),{recursive:true});copyFileSync(module,resolve(resources,id,'ss_nip.so'));
 const inputs=['Cargo.toml','Cargo.lock','src/lib.rs','src/ffi.rs','zle.c','zle.zsh','psreadline.cs','psreadline.ps1'].map(path=>`src-tauri/native-input-editors/${path}`);
 inputs.push('src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_jobs.rs','src-tauri/src/terminal_jobs.ps1','src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs','scripts/native-input/acceptance/build.mjs','scripts/native-input/acceptance/zsh-build-check.c','scripts/native-input/acceptance/build-paired-candidate.mjs');
 const profile={shell:'zsh',shellVersion:'5.9',editor:'zle',editorVersion:'5.9',editorNumericVersion:509,adapterVersion:'1',verifiedProfileId:id};
 const catalogue={version:1,profiles:[{profile,shellSha256:hash(shell),moduleSha256:hash(module),module:`${id}/ss_nip.so`}],sources:Object.fromEntries(inputs.map(path=>[path,hash(resolve(root,path))]))};
 copyFileSync(resolve(resources,'editors-macos-arm64.json'),resolve(directory,'previous-editor-catalogue.json'));
 writeFileSync(resolve(resources,'editors-macos-arm64.json'),JSON.stringify(catalogue,null,2));
 const record={kind:'complete-isolated-upstream-runtime',shell,prefix,source,module,shellSha256:hash(shell),moduleSha256:hash(module),archiveSha256:hash(archive),nativeAcceptance:false,productionBindingChanged:false};
 writeFileSync(resolve(directory,'producer.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}finally{closeSync(fd);}

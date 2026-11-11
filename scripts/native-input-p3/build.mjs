import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync,openSync,closeSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const target=process.platform==='darwin'&&process.arch==='arm64'?'macos-arm64':process.platform==='linux'&&process.arch==='arm64'?'linux-aarch64-glibc-2.36':null;
assert(target,'Build and verify this provider on its real target');
const directory=resolve(root,'.artifacts/tests/native-input-p3');const dependencies=resolve(directory,'dependencies');
mkdirSync(dependencies,{recursive:true,mode:0o700});
const log=openSync(resolve(directory,'build.log'),'a',0o600);
function run(command,args,cwd=root){execFileSync(command,args,{cwd,stdio:['ignore',log,log]});}
const archive=resolve(dependencies,'zsh-5.9.tar.xz');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const buildScopedCore=process.argv.includes('--build-scoped-core');
try{
  if(!existsSync(archive))run('curl',['--fail','--location','--proto','=https','--tlsv1.2','https://www.zsh.org/pub/old/zsh-5.9.tar.xz','-o',archive]);
  assert.equal(sha(archive),'9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5');
  const coreProducerPath=buildScopedCore
    ? resolve(JSON.parse(execFileSync(process.execPath,['scripts/native-input-p3/build-scoped-core.mjs',archive],{cwd:root,encoding:'utf8',stdio:['ignore','pipe',log]})).directory,'producer.json')
    : process.env.SHELLSPAN_P3_SCOPED_CORE_PRODUCER;
  const coreProducer=coreProducerPath?JSON.parse(readFileSync(coreProducerPath,'utf8')):undefined;
  const boundHistory=target==='macos-arm64'&&coreProducer?.boundHistory===true;
  // Each SDK starts from the released archive. Copying a configured tree can
  // reorder mtimes and accidentally require regenerating released autotools.
  const sdk=resolve(directory,'sdk-build',randomUUID());mkdirSync(sdk,{recursive:true});
  const source=resolve(sdk,'zsh-5.9');run('tar',['-xf',archive,'-C',sdk]);
  // Zsh 5.9's released configure probes use C89 implicit-int definitions.
  // Compile that dependency in its original language dialect, so current
  // Clang does not turn probe compilation errors into false "broken" APIs.
  run('./configure',['--disable-gdbm','--with-tcsetpgrp','CFLAGS=-O2 -std=gnu89'],source);
  run(process.env.CC??'cc',['-std=c11','-I',source,'scripts/native-input-p3/zsh-build-check.c','-o',resolve(directory,'zsh-build-check')]);
  run('make',['-j4'],source);
  execFileSync(resolve(source,'Src/zsh'),['-f','-c','value=$(/usr/bin/printf %s P3_CONFIG); [[ $value == P3_CONFIG ]]'],{timeout:5000,stdio:['ignore',log,log]});
  run('cargo',['build','--locked','--release','--manifest-path','src-tauri/native-input-editors/Cargo.toml','--lib']);
  const module=resolve(directory,'ss_nip.so');
  const flags=target==='macos-arm64'?['-bundle','-undefined','dynamic_lookup']:['-shared','-Wl,--exclude-libs,ALL'];
  run(process.env.CC??'cc',['-std=c11','-DMODULE','-fPIC',...(boundHistory?['-DSHELLSPAN_ZLE_BOUND_HISTORY=1']:[]),...flags,'-I',resolve(source,'Src'),
    'src-tauri/native-input-editors/zle.c','src-tauri/native-input-editors/target/release/libshellspan_native_input_editors.a','-lpthread','-ldl','-lm','-o',module]);
  const shell=(buildScopedCore?coreProducer?.shell:process.env.SHELLSPAN_P3_ZSH??coreProducer?.shell)??'/bin/zsh';
  assert.equal(execFileSync(shell,['-f','-c','print -rn -- $ZSH_VERSION'],{encoding:'utf8'}),'5.9');
  const id=`zsh-5.9-zle-5.9-${target}-native`;
  const profile={shell:'zsh',shellVersion:'5.9',editor:'zle',editorVersion:'5.9',editorNumericVersion:509,adapterVersion:'1',verifiedProfileId:id};
  const sourcePaths=['Cargo.toml','Cargo.lock','src/lib.rs','src/ffi.rs','zle.c','zle.zsh','psreadline.cs','psreadline.ps1'].map(path=>`src-tauri/native-input-editors/${path}`);
  sourcePaths.push('src-tauri/src/terminal_command/protocol.rs');
  sourcePaths.push('src-tauri/src/terminal_jobs.rs','src-tauri/src/terminal_jobs.ps1','src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs');
  sourcePaths.push('scripts/native-input-p3/build.mjs','scripts/native-input-p3/zsh-build-check.c');
  if(coreProducerPath){
    assert(coreProducer.nativeAcceptance===false&&coreProducer.productionChanges===false&&coreProducer.target===target);
    assert.equal(sha(coreProducer.editor),coreProducer.editorSha256);assert.equal(coreProducer.shell,shell);assert.equal(coreProducer.shellSha256,sha(shell));
    const pin=JSON.parse(readFileSync(resolve(root,'scripts/dependency-builds/zsh/pin.json'),'utf8'));
    assert.equal(sha(resolve(root,'scripts/dependency-builds/zsh/pin.json')),coreProducer.pinSha256);
    assert.equal(sha(resolve(root,pin.patch)),pin.patchSha256);assert.equal(coreProducer.patchSha256,pin.patchSha256);
    const expectedSources=boundHistory?{...pin.history.sourceHashes,...pin.macosRefresh.sourceHashes}:pin.sourceHashes;
    assert.deepEqual(coreProducer.nativeSourceHashes,expectedSources);
    for(const[name,digest]of Object.entries(expectedSources))assert.equal(sha(resolve(coreProducer.source,boundHistory?name:`Src/Zle/${name}`)),digest);
    if(target==='macos-arm64'){
      assert(boundHistory,'The macOS native editor requires its matched history-capable private main/Core');
      assert.equal(sha(shell),pin.targets[target].privateMainSha256);assert.equal(sha(coreProducer.editor),pin.targets[target].privateCoreSha256);
      assert.equal(coreProducer.historyPatchSha256,pin.history.patchSha256);assert.equal(sha(resolve(root,pin.history.patch)),pin.history.patchSha256);
      assert.equal(coreProducer.macosRefreshPatchSha256,pin.macosRefresh.patchSha256);assert.equal(sha(resolve(root,pin.macosRefresh.patch)),pin.macosRefresh.patchSha256);
      sourcePaths.push(pin.history.patch,pin.macosRefresh.patch);
    }
    sourcePaths.push('scripts/dependency-builds/zsh/pin.json','scripts/dependency-builds/zsh/native-display.patch','scripts/native-input-p3/build-scoped-core.mjs');
  }
  const sources=Object.fromEntries(sourcePaths.map(path=>[path,sha(resolve(root,path))]));
  const resources=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input');
  mkdirSync(resolve(resources,id),{recursive:true});const destination=resolve(resources,id,'ss_nip.so');if(existsSync(destination))chmodSync(destination,0o600);copyFileSync(module,destination);chmodSync(destination,0o500);
  const editor={profile,shellSha256:sha(shell),moduleSha256:sha(module),module:`${id}/ss_nip.so`};
  if(coreProducer){
    const core=resolve(resources,id,'zle.so');if(existsSync(core))chmodSync(core,0o600);copyFileSync(coreProducer.editor,core);chmodSync(core,0o500);assert.equal(sha(core),coreProducer.editorSha256);
    copyFileSync(resolve(coreProducer.directory,'LICENCE.zsh'),resolve(resources,id,'LICENCE.zsh'));
    Object.assign(editor,{core:`${id}/zle.so`,editorSha256:sha(core),coreLicense:`${id}/LICENCE.zsh`,coreLicenseSha256:sha(resolve(resources,id,'LICENCE.zsh'))});
    if(boundHistory){
      const privateShell=resolve(resources,id,'zsh');if(existsSync(privateShell))chmodSync(privateShell,0o600);
      copyFileSync(shell,privateShell);chmodSync(privateShell,0o500);assert.equal(sha(privateShell),editor.shellSha256);
      editor.shell=`${id}/zsh`;
    }
  }
  const catalogue={version:1,profiles:[editor],sources};
  writeFileSync(resolve(resources,`editors-${target}.json`),JSON.stringify(catalogue,null,2)+'\n');
  writeFileSync(resolve(directory,`producer-${target}.json`),JSON.stringify({shell,archiveSha256:sha(archive),...catalogue},null,2)+'\n');
  console.log(JSON.stringify({target,module,shell,profileId:id,moduleSha256:sha(module)}));
}finally{closeSync(log);}

// Reproducible source recipe for the candidate Core. Never installs/replaces a
// user Shell, writes user configuration, or enables a production profile.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),pinPath=resolve(root,'scripts/dependency-builds/zsh/pin.json');
const pin=JSON.parse(readFileSync(pinPath,'utf8')),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const target=process.platform==='darwin'&&process.arch==='arm64'?'macos-arm64':process.platform==='linux'&&process.arch==='arm64'?'linux-aarch64-glibc-2.36':undefined;
assert(target&&pin.targets[target]);const specification=pin.targets[target];
if(process.platform==='linux')assert.equal(execFileSync('getconf',['GNU_LIBC_VERSION'],{encoding:'utf8'}).trim(),'glibc 2.36');
const main='/bin/zsh',mainSha256=hash(main);assert.equal(mainSha256,specification.mainSha256);
const archive=resolve(process.argv[2]??resolve(root,'.native-input-p3/dependencies/zsh-5.9.tar.xz')),patch=resolve(root,pin.patch);
assert.equal(hash(archive),pin.archiveSha256);assert.equal(hash(patch),pin.patchSha256);
const directory=resolve(root,'.native-input-p3/pinned-core',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const source=resolve(directory,`zsh-${pin.version}`),prefix=resolve(directory,'install'),fd=openSync(resolve(directory,'build.log'),'wx');
const configureArgs=[`--prefix=${prefix}`,'--disable-gdbm','--with-tcsetpgrp',specification.unicode9Default?'--enable-unicode9':'--disable-unicode9','CFLAGS=-O2 -std=gnu89'];
const inputs={pinSha256:hash(pinPath),patchSha256:hash(patch),archiveSha256:hash(archive),sourceHashes:pin.sourceHashes,target,main,mainSha256,configureArgs,productionProfileEnabled:false};
writeFileSync(resolve(directory,'inputs.json'),JSON.stringify(inputs,null,2),{flag:'wx'});
const run=(command,args,cwd=root)=>execFileSync(command,args,{cwd,stdio:['ignore',fd,fd]});
try{
 run('tar',['-xf',archive,'-C',directory]);run('patch',['-p1','-F','0','-t','-i',patch],source);
 for(const[name,digest]of Object.entries(pin.sourceHashes))assert.equal(hash(resolve(source,'Src/Zle',name)),digest);
 if(!process.argv.includes('--source-only')){
  run('./configure',configureArgs,source);run('make',['-j4'],source);run('make',['install.modules'],source);
  const editor=resolve(prefix,`lib/zsh/${pin.version}/zsh/zle.so`);assert.equal(hash(main),mainSha256);
  copyFileSync(resolve(source,'LICENCE'),resolve(directory,'LICENCE.zsh'));
  writeFileSync(resolve(directory,'producer.json'),JSON.stringify({...inputs,directory,source,prefix,editor,editorSha256:hash(editor),unicode9Default:specification.unicode9Default,shell:main,shellSha256:mainSha256,nativeSourceHashes:pin.sourceHashes,nativeAcceptance:false,productionChanges:false},null,2),{flag:'wx'});
 }
 assert.equal(hash(pinPath),inputs.pinSha256);assert.equal(hash(patch),inputs.patchSha256);
 for(const[name,digest]of Object.entries(pin.sourceHashes))assert.equal(hash(resolve(source,'Src/Zle',name)),digest);
 writeFileSync(resolve(directory,'result.json'),JSON.stringify({ok:true,directory,sourceOnly:process.argv.includes('--source-only'),inputs},null,2),{flag:'wx'});
 console.log(JSON.stringify({directory,sourceOnly:process.argv.includes('--source-only'),ok:true}));
}finally{closeSync(fd);}

// A fresh private Core revision. The reviewed parent is read-only throughout.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const owner=resolve(import.meta.dirname,'../..'),action=process.argv[2];
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
if(action==='stage'){
 const producerFile=resolve(process.argv[3]),parent=JSON.parse(readFileSync(producerFile,'utf8'));
 assert(parent.nativeAcceptance===false&&parent.productionChanges===false&&parent.unicode9Default===true);
 assert.equal(hash(parent.editor),parent.editorSha256);assert.equal(hash(parent.shell),parent.shellSha256);
 const archive=resolve(owner,'.artifacts/tests/native-input-p3/dependencies/zsh-5.9.tar.xz');assert.equal(hash(archive),parent.archiveSha256);
 const directory=resolve(owner,'.artifacts/tests/native-input-p3/scoped-core-revision',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
 execFileSync('tar',['-xf',archive,'-C',directory],{stdio:'pipe'});const source=resolve(directory,'zsh-5.9');
 for(const [name,digest]of Object.entries(parent.nativeSourceHashes)){const from=resolve(parent.source,'Src/Zle',name);assert.equal(hash(from),digest);copyFileSync(from,resolve(source,'Src/Zle',name));}
 const stage={directory,source,prefix:resolve(directory,'install'),parent:producerFile,parentHashes:parent.nativeSourceHashes,archiveSha256:parent.archiveSha256,shell:parent.shell,shellSha256:parent.shellSha256,unicode9Default:true,sealed:false,nativeAcceptance:false,productionChanges:false};
 writeFileSync(resolve(directory,'stage.json'),JSON.stringify(stage,null,2),{flag:'wx'});console.log(JSON.stringify({directory,source,sealed:false}));
}else if(action==='build'){
 const directory=resolve(process.argv[3]);assert(directory.startsWith(resolve(owner,'.artifacts/tests/native-input-p3/scoped-core-revision')+'/'));
 const file=resolve(directory,'stage.json'),stage=JSON.parse(readFileSync(file,'utf8'));assert(stage.directory===directory&&!stage.sealed);
 const hashes=Object.fromEntries(Object.keys(stage.parentHashes).map(name=>[name,hash(resolve(stage.source,'Src/Zle',name))]));
 assert.deepEqual(Object.keys(hashes).filter(name=>hashes[name]!==stage.parentHashes[name]),['zle_refresh.c']);
 const parent=JSON.parse(readFileSync(stage.parent,'utf8'));for(const[name,digest]of Object.entries(stage.parentHashes))assert.equal(hash(resolve(parent.source,'Src/Zle',name)),digest);
 const configureArgs=[`--prefix=${stage.prefix}`,'--disable-gdbm','--with-tcsetpgrp','--enable-unicode9','CFLAGS=-O2 -std=gnu89'];
 writeFileSync(file,JSON.stringify({...stage,sealed:true,nativeSourceHashes:hashes,configureArgs},null,2));
 const fd=openSync(resolve(directory,'build.log'),'wx');
 try{for(const[cmd,args]of[['./configure',configureArgs],['make',['-j4']],['make',['install.bin']],['make',['install.modules']],['make',['install.fns']]])execFileSync(cmd,args,{cwd:stage.source,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
 const editor=resolve(stage.prefix,'lib/zsh/5.9/zsh/zle.so');assert.equal(hash(stage.shell),stage.shellSha256);
 for(const[name,digest]of Object.entries(hashes))assert.equal(hash(resolve(stage.source,'Src/Zle',name)),digest);
 const producer={...stage,sealed:true,nativeSourceHashes:hashes,configureArgs,editor,editorSha256:hash(editor)};
 writeFileSync(resolve(directory,'producer.json'),JSON.stringify(producer,null,2),{flag:'wx'});console.log(JSON.stringify({directory,editor,editorSha256:producer.editorSha256}));
}else throw new Error('Use stage <parent producer> or build <fresh staged revision>');

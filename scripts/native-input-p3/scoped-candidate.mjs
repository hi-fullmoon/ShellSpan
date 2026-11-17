// Explicitly unsealed full source copy; edits are made with the file-edit tool.
// seal records every allowed override before any acceptance command can run.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,cpSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {createIndexReader} from './index-reader.mjs';
const owner=resolve(import.meta.dirname,'../..'),action=process.argv[2];
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const overrides=['src-tauri/native-input-editors/src/ffi.rs','src-tauri/native-input-editors/zle.c','src-tauri/native-input-editors/zle.zsh','src-tauri/src/terminal_command/local.rs','src-tauri/src/terminal_command/remote.rs','src-tauri/src/terminal_command/remote_tests.rs','src-tauri/src/terminal_command/zle_tests.rs','scripts/native-input-p3/zle-live.mjs','scripts/native-input-p3/linux-build.sh','scripts/native-input-p3/publish-linux.py','scripts/native-input-p3/linux-fixture.mjs','src/lib/terminal/native-input-display.ts','src/lib/terminal/__tests__/native-input-display-binding.browser.mjs','src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_command/registration.rs','src-tauri/src/terminal_command/coordinator.rs','src-tauri/src/terminal_broker.rs','src/types/index.ts','src/components/terminal/registry/terminal-registry.ts','package.json','pnpm-lock.yaml','scripts/native-input-p3/build.mjs'];
const reviewedInputs=['scripts/dependency-builds/zsh/pin.json','scripts/dependency-builds/zsh/native-display.patch','scripts/native-input-p3/build-scoped-core.mjs','protocol/agent/runtime/native-editor-admission.json','scripts/native-input-p3/editor-validation.mjs'];
reviewedInputs.push('scripts/dependency-builds/xterm/build.json','scripts/dependency-builds/xterm/artifacts.json','scripts/native-input-p0/xterm-viewport-reflow.patch','patches/@xterm__xterm@6.0.0.patch','pnpm-lock.yaml','pnpm-workspace.yaml');
reviewedInputs.push('scripts/native-input-p3/app.mjs','scripts/native-input-p3/linux-peer.mjs','scripts/verify-ai-session-stream.mjs');
reviewedInputs.push('src-tauri/src/agent_runtime/scratch.rs','src-tauri/src/agent_runtime/scratch_storage.rs','src-tauri/src/agent_runtime/tests/scratch.rs','src/components/terminal/__tests__/native-jobs.native.tsx');
reviewedInputs.push('src/components/terminal/__tests__/native-focus-trace.ts','src/components/terminal/__tests__/native-focus-trace.browser.mjs','scripts/native-input-p3/focus-trace-channel.mjs');
overrides.push('src-tauri/src/terminal_command/editors.rs','scripts/prepare-native-input-resources.mjs');
overrides.push('scripts/native-input-p3/app.mjs');
overrides.push('src-tauri/src/terminal_command/artifacts.rs');
overrides.push('scripts/native-input-p3/zle-history-live.mjs','scripts/native-input-p3/ssh-live.mjs');
if(action==='stage'){
 const directory=resolve(owner,'artifacts/tests/native-input-p3/acceptance-source',randomUUID()),root=resolve(directory,'ShellSpan'),meta=resolve(root,'artifacts/tests/native-input-p3');
 mkdirSync(meta,{recursive:true,mode:0o700});const sources=captureValidationSources(owner);
 for(const path of Object.keys(sources)){mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(owner,path),resolve(root,path));}
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:owner,encoding:'utf8'}).trim();
 const original=execFileSync('git',['rev-parse','--path-format=absolute','--git-path','index'],{cwd:owner,encoding:'utf8'}).trim();
 const {index,gitDirectory}=createIndexReader(meta,original,head);chmodSync(index,0o400);
 writeFileSync(resolve(meta,'snapshot-index.json'),JSON.stringify({version:1,root,index,indexSha256:hash(index),gitDirectory,purpose:'Unsealed isolated candidate; copied read-only index, no refs or registered worktree'},null,2));
 assert.deepEqual(captureValidationSources(owner),sources);assert.deepEqual(captureValidationSources(root),sources);
 cpSync(resolve(owner,'artifacts/tests/native-input-p2/resources'),resolve(root,'artifacts/tests/native-input-p2/resources'),{recursive:true});
 const producerFile=resolve(process.argv[3]),producer=JSON.parse(readFileSync(producerFile,'utf8'));
 assert(producer.nativeAcceptance===false&&producer.productionChanges===false&&producer.unicode9Default===true);
 assert.equal(producer.shell,'/bin/zsh');assert.equal(hash('/bin/zsh'),producer.shellSha256);assert.equal(hash(producer.editor),producer.editorSha256);
 assert.equal(producer.editorSha256,'521e7ca22ecc1727d059d13f5034df71ac0eca88a176c09d5bfc59c0e46c87fc');
 const core=resolve(root,'artifacts/tests/native-input-p2/resources/native-input/scoped-core/macos-arm64/zsh/zle.so');mkdirSync(dirname(core),{recursive:true});copyFileSync(producer.editor,core);chmodSync(core,0o500);assert.equal(hash(core),producer.editorSha256);
 writeFileSync(resolve(meta,'candidate-base-sources.json'),JSON.stringify(sources,null,2));
 writeFileSync(resolve(meta,'candidate-stage.json'),JSON.stringify({root,directory,owner,head,sealed:false,overrides,producerFile,producer,core,coreSha256:hash(core),mainSha256:hash('/bin/zsh'),nativeAcceptance:false,productionBindingChanged:false},null,2));
 console.log(JSON.stringify({root,sealed:false,sourceCount:Object.keys(sources).length}));
}else if(action==='revise'){
 const parent=resolve(process.argv[3]),old=JSON.parse(readFileSync(resolve(parent,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));assert(old.sealed&&old.root===parent);
 const parentSources=captureValidationSources(parent);assert.deepEqual(parentSources,JSON.parse(readFileSync(resolve(old.directory,'sources.json'),'utf8')));
 const directory=resolve(owner,'artifacts/tests/native-input-p3/acceptance-source',randomUUID()),root=resolve(directory,'ShellSpan'),meta=resolve(root,'artifacts/tests/native-input-p3');mkdirSync(meta,{recursive:true,mode:0o700});
 for(const path of Object.keys(parentSources)){mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(parent,path),resolve(root,path));}
 const oldIndex=JSON.parse(readFileSync(resolve(parent,'artifacts/tests/native-input-p3/snapshot-index.json'),'utf8'));
 const {index,gitDirectory}=createIndexReader(meta,oldIndex.index,old.head);chmodSync(index,0o400);
 writeFileSync(resolve(meta,'snapshot-index.json'),JSON.stringify({version:1,root,index,indexSha256:hash(index),gitDirectory,purpose:'New unsealed candidate revision; copied read-only index, parent is immutable'},null,2));
 assert.deepEqual(captureValidationSources(root),parentSources);assert.deepEqual(captureValidationSources(parent),parentSources);
 cpSync(resolve(parent,'artifacts/tests/native-input-p2/resources'),resolve(root,'artifacts/tests/native-input-p2/resources'),{recursive:true});
 cpSync(resolve(parent,'artifacts/tests/native-input-p3/dependencies'),resolve(meta,'dependencies'),{recursive:true});
 copyFileSync(resolve(parent,'artifacts/tests/native-input-p3/candidate-base-sources.json'),resolve(meta,'candidate-base-sources.json'));
 writeFileSync(resolve(meta,'candidate-parent-sources.json'),JSON.stringify(parentSources,null,2));
 const coreRelative=relative(parent,old.core);assert(coreRelative.startsWith('artifacts/tests/native-input-p2/resources/native-input/')&&!coreRelative.split('/').includes('..'));
 const core=resolve(root,coreRelative);assert.equal(hash(core),old.coreSha256);
 writeFileSync(resolve(meta,'candidate-stage.json'),JSON.stringify({...old,root,directory,core,sealed:false,parent,overrides},null,2));
 console.log(JSON.stringify({root,parent,sealed:false,sourceCount:Object.keys(parentSources).length}));
}else if(action==='add-inputs'){
 const root=resolve(process.argv[3]);assert(root.startsWith(resolve(owner,'artifacts/tests/native-input-p3/acceptance-source')+'/'));
 const file=resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),stage=JSON.parse(readFileSync(file,'utf8'));assert(stage.root===root&&!stage.sealed);
 const added={};for(const path of reviewedInputs){const source=resolve(owner,path),target=resolve(root,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);added[path]=hash(source);assert.equal(hash(target),added[path]);}
 writeFileSync(resolve(root,`artifacts/tests/native-input-p3/added-inputs-${randomUUID()}.json`),JSON.stringify({owner,added},null,2),{flag:'wx'});console.log(JSON.stringify({root,added}));
}else if(action==='bind-core'){
 const root=resolve(process.argv[3]),producerFile=resolve(process.argv[4]);assert(root.startsWith(resolve(owner,'artifacts/tests/native-input-p3/acceptance-source')+'/'));
 const file=resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),stage=JSON.parse(readFileSync(file,'utf8'));assert(stage.root===root&&!stage.sealed);
 const producer=JSON.parse(readFileSync(producerFile,'utf8'));assert(producer.sealed&&producer.unicode9Default&&producer.nativeAcceptance===false&&producer.productionChanges===false);
 const parent=JSON.parse(readFileSync(producer.parent,'utf8'));assert(['521e7ca22ecc1727d059d13f5034df71ac0eca88a176c09d5bfc59c0e46c87fc','9e38b0b15228aa86bd20a240c0034c3340c7846778babb53f99f1a1f79043ceb'].includes(parent.editorSha256));
 if(parent.editorSha256==='9e38b0b15228aa86bd20a240c0034c3340c7846778babb53f99f1a1f79043ceb'){
   const pin=JSON.parse(readFileSync(resolve(root,'scripts/dependency-builds/zsh/pin.json'),'utf8'));assert.deepEqual(producer.nativeSourceHashes,pin.sourceHashes);assert.equal(hash(resolve(root,pin.patch)),pin.patchSha256);
   assert.equal(producer.editorSha256,'204b5d23a4ac312283650b1d20a57f380557206a0928a6d9b37347d477ac0e84');
 }
 assert.equal(hash(parent.editor),parent.editorSha256);assert.equal(producer.shell,'/bin/zsh');assert.equal(hash('/bin/zsh'),producer.shellSha256);assert.equal(producer.shellSha256,stage.mainSha256);assert.equal(hash(producer.editor),producer.editorSha256);
 for(const[name,digest]of Object.entries(producer.nativeSourceHashes))assert.equal(hash(resolve(producer.source,'Src/Zle',name)),digest);
 assert.equal(hash(stage.core),stage.coreSha256);chmodSync(stage.core,0o600);copyFileSync(producer.editor,stage.core);chmodSync(stage.core,0o500);assert.equal(hash(stage.core),producer.editorSha256);
 writeFileSync(file,JSON.stringify({...stage,producerFile,producer,coreSha256:producer.editorSha256},null,2));console.log(JSON.stringify({root,sealed:false,coreSha256:producer.editorSha256}));
}else if(action==='seal'){
 const root=resolve(process.argv[3]);assert(root.startsWith(resolve(owner,'artifacts/tests/native-input-p3/acceptance-source')+'/'));
 const meta=resolve(root,'artifacts/tests/native-input-p3'),file=resolve(meta,'candidate-stage.json'),stage=JSON.parse(readFileSync(file,'utf8'));assert.equal(stage.root,root);assert.equal(stage.sealed,false);
 const base=JSON.parse(readFileSync(resolve(meta,'candidate-base-sources.json'),'utf8')),sources=captureValidationSources(root);
 assert(Object.keys(base).every(path=>path in sources),'Candidate must retain the entire copied source set');
 assert(Object.keys(sources).filter(path=>!(path in base)).every(path=>reviewedInputs.includes(path)),'Unexpected added source input');
 const changed=Object.keys(sources).filter(path=>sources[path]!==base[path]);assert(changed.length>0&&changed.every(path=>overrides.includes(path)||reviewedInputs.includes(path)),`Unexpected experimental source change: ${changed}`);
 assert.equal(hash(stage.core),stage.coreSha256);assert.equal(hash('/bin/zsh'),stage.mainSha256);
 writeFileSync(resolve(stage.directory,'sources.json'),JSON.stringify(sources,null,2),{flag:'wx'});
 writeFileSync(resolve(stage.directory,'snapshot.json'),JSON.stringify({...stage,sealed:true,explicitOverrides:changed,sourceCount:Object.keys(sources).length},null,2),{flag:'wx'});
 writeFileSync(file,JSON.stringify({...stage,sealed:true,explicitOverrides:changed,sourceCount:Object.keys(sources).length},null,2));
 console.log(JSON.stringify({root,sealed:true,sourceCount:Object.keys(sources).length,explicitOverrides:changed}));
}else throw new Error('Use stage <producer>, revise <sealed root>, bind-core <new staged root> <producer>, or seal <new staged root>');

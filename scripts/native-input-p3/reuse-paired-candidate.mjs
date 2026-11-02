// Reuses explicitly identified, source-matching experimental binaries. This is
// metadata correction for the canonical verified profile, never a fresh build.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {artifactWorkspace} from '../artifact-paths.mjs';
const root=resolve(import.meta.dirname,'../..');assert(root.includes('/.artifacts/tests/native-input-p3/acceptance-source/')&&JSON.parse(readFileSync(resolve(root,'.artifacts/tests/native-input-p3/snapshot-index.json'),'utf8')).root===root);
const producerFile=resolve(process.argv[2]),producer=JSON.parse(readFileSync(producerFile,'utf8'));
assert(producer.nativeAcceptance===false&&producer.productionBindingChanged===false);
const producerRoot=artifactWorkspace(producerFile);
const old=JSON.parse(readFileSync(resolve(producerRoot,'.artifacts/tests/native-input-p2/resources/native-input/editors-macos-arm64.json'),'utf8'));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const compileInputs=['Cargo.toml','Cargo.lock','src/lib.rs','src/ffi.rs','zle.c'].map(path=>`src-tauri/native-input-editors/${path}`).concat(['src-tauri/src/terminal_command/protocol.rs']);
for(const path of compileInputs)assert.equal(hash(resolve(root,path)),old.sources[path],`Actual candidate compile input changed: ${path}`);
assert.equal(hash(producer.shell),producer.shellSha256);assert.equal(hash(producer.module),producer.moduleSha256);
const id='zsh-5.9-zle-5.9-macos-arm64-native',resources=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input');
mkdirSync(resolve(resources,id),{recursive:true});
const directory=resolve(root,'.artifacts/tests/native-input-p3/paired-reuse');mkdirSync(directory,{recursive:true});
copyFileSync(resolve(resources,'editors-macos-arm64.json'),resolve(directory,'previous-editor-catalogue.json'));
copyFileSync(producer.module,resolve(resources,id,'ss_nip.so'));
const profile={...old.profiles[0].profile,verifiedProfileId:id};
const inputs=Object.keys(old.sources).filter(path=>path!=='scripts/native-input-p3/build-paired-candidate.mjs');inputs.push('scripts/native-input-p3/reuse-paired-candidate.mjs','scripts/artifact-paths.mjs');
const catalogue={version:1,profiles:[{profile,shellSha256:producer.shellSha256,moduleSha256:producer.moduleSha256,module:`${id}/ss_nip.so`}],sources:Object.fromEntries(inputs.map(path=>[path,hash(resolve(root,path))]))};
writeFileSync(resolve(resources,'editors-macos-arm64.json'),JSON.stringify(catalogue,null,2));
writeFileSync(resolve(directory,'producer.json'),JSON.stringify({producerFile,compileInputs,reusedProducer:producer,nativeAcceptance:false,productionBindingChanged:false,actualRebuild:false},null,2));
console.log(JSON.stringify({root,shell:producer.shell,nativeAcceptance:false,actualRebuild:false,producerFile}));

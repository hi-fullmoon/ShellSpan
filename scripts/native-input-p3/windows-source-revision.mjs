import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
assert.equal(process.platform,'win32');
const base=resolve(process.argv[2]),overrides=resolve(process.argv[3]);
assert(/^D:\\Developer\\ShellSpan-native-input-p3-app-[a-f0-9-]{36}$/.test(base));
const {captureValidationSources}=await import(pathToFileURL(resolve(base,'scripts/native-input-p2/frozen-validation.mjs')));
const {createIndexReader}=await import(pathToFileURL(resolve(base,'scripts/native-input-p3/index-reader.mjs')));
const id=randomUUID(),root=resolve('D:/Developer',`ShellSpan-native-input-p3-app-${id}`),meta=resolve(root,'.artifacts/tests/native-input-p3');mkdirSync(meta,{recursive:true});
const before=captureValidationSources(base);const parent=JSON.parse(readFileSync(resolve(base,'.artifacts/tests/native-input-p3/import.json'),'utf8'));
const baseIndex=JSON.parse(readFileSync(resolve(base,'.artifacts/tests/native-input-p3/snapshot-index.json'),'utf8'));
const changed=['.gitignore','scripts/verify-ai-session-stream.mjs','scripts/native-input-p2/frozen-validation.mjs','scripts/native-input-p3/desktop-evidence.mjs','scripts/native-input-p3/windows-source-revision.mjs','scripts/native-input-p3/windows-cargo-runner.mjs','src-tauri/src/terminal_command/windows.rs','src-tauri/src/terminal_integration.rs','src-tauri/resources/powershell/PSReadLine/2.4.5/netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll','src-tauri/resources/powershell/PSReadLine/2.4.5/net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll','src-tauri/native-input-editors/psreadline.ps1','src-tauri/native-input-editors/examples/windows_acceptance.rs',
 'scripts/native-input-p3/credential-channel.mjs','scripts/native-input-p3/credential-relay.mjs','scripts/native-input-p3/credential-ownership.mjs','scripts/native-input-p3/credential-cleanup/Cargo.toml','scripts/native-input-p3/credential-cleanup/Cargo.lock','scripts/native-input-p3/credential-cleanup/src/main.rs','scripts/native-input-p3/windows-credential-worker.ps1','scripts/native-input-p3/windows-credential-quiesce.ps1','scripts/native-input-p3/windows-publisher.ps1','src-tauri/native-input-editors/src/ffi.rs',
 'src/components/terminal/__tests__/native-input-p3-credential.ts','src/components/terminal/__tests__/native-data-initialize.native.ts','src/components/terminal/__tests__/native-jobs.native.tsx','src/components/terminal/__tests__/native-input-p3-startup.native.html','src/components/terminal/__tests__/native-input-p3-startup.native.ts','src/components/terminal/__tests__/native-input-p3-publisher.ts'];
changed.push('src-tauri/src/terminal_command/journal.rs','src-tauri/src/agent_runtime/scratch.rs','src-tauri/src/agent_runtime/scratch_storage.rs','src-tauri/src/agent_runtime/tests/scratch.rs');
changed.push('scripts/native-input-p2/gui-lock.mjs','scripts/native-input-p3/focus-trace-channel.mjs','src/components/terminal/__tests__/native-focus-trace.ts');
for(const path of Object.keys(before)){
  assert(resolve(root,path).startsWith(root+sep));mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(base,path),resolve(root,path));
}
assert.deepEqual(captureValidationSources(base),before,'The complete source parent changed during revision copying');
for(const path of changed){mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(overrides,path),resolve(root,path));}
const {index,gitDirectory}=createIndexReader(meta,baseIndex.index,parent.head);
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(resolve(meta,'snapshot-index.json'),JSON.stringify({version:1,root,index,gitDirectory,indexSha256:hash(index),purpose:'Full Windows revision after actual compiler generation; copied index, no refs or commits.'},null,2));
const sources=captureValidationSources(root);
assert.equal(Object.keys(sources).length,Object.keys(before).length+changed.filter(path=>!(path in before)).length);
const actualChanges=Object.keys(sources).filter(path=>sources[path]!==before[path]).sort();
assert(actualChanges.length>0&&actualChanges.every(path=>changed.includes(path)));
const original=JSON.parse(readFileSync(resolve(base,'.artifacts/tests/native-input-p3/sources.json'),'utf8'));
const generated=Object.keys(before).filter(path=>before[path]!==original[path]);assert(generated.every(path=>path==='src-tauri/gen/schemas/windows-schema.json'));
writeFileSync(resolve(meta,'sources.json'),JSON.stringify(sources,null,2));
const files=resolve(meta,'source-files.list');writeFileSync(files,Object.keys(sources).join('\0')+'\0');execFileSync('tar.exe',['-czf',resolve(meta,'source.tar.gz'),'--null','-T',files],{cwd:root});
writeFileSync(resolve(meta,'import.json'),JSON.stringify({id,head:parent.head,sourceParent:base,parentArchiveSha256:hash(resolve(base,'.artifacts/tests/native-input-p3/source.tar.gz')),
  generatedByActualWindowsCompiler:generated,explicitFixtureChanges:actualChanges,sourceCount:Object.keys(sources).length,sourceArchiveSha256:hash(resolve(meta,'source.tar.gz'))},null,2));
execFileSync('cmd.exe',['/d','/c','mklink','/J',resolve(root,'node_modules'),resolve(base,'node_modules')],{stdio:'pipe'});
cpSync(resolve(base,'.artifacts/tests/native-input-p2/resources'),resolve(root,'.artifacts/tests/native-input-p2/resources'),{recursive:true});
const packagedResources='.artifacts/releases/native-input/generated';
if(existsSync(resolve(base,packagedResources))){mkdirSync(dirname(resolve(root,packagedResources)),{recursive:true});cpSync(resolve(base,packagedResources),resolve(root,packagedResources),{recursive:true});}
assert.deepEqual(captureValidationSources(root),sources);
console.log(JSON.stringify({root,id,sourceCount:Object.keys(sources).length,sourceParent:base,generatedByActualWindowsCompiler:generated,fixtureChanges:actualChanges,nativeAcceptance:false}));

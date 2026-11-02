import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
export function auditEditorResources(root,selectedTarget){
  const resources=resolve(root,'.native-input-p2/resources/native-input-v1');
  const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const entries=[];
  for(const name of readdirSync(resources).filter(name=>/^editors-.*\.json$/.test(name))){
    const catalogue=JSON.parse(readFileSync(resolve(resources,name),'utf8'));
    const sourceMismatches=Object.entries(catalogue.sources).filter(([path,digest])=>hash(resolve(root,path))!==digest).map(([path])=>path);
    const artifactMismatches=[];
    for(const profile of catalogue.profiles){for(const [path,digest]of[[profile.module,profile.moduleSha256],[profile.relay,profile.relaySha256],[profile.core,profile.editorSha256],[profile.coreLicense,profile.coreLicenseSha256]]){
      if(path&&hash(resolve(resources,path))!==digest)artifactMismatches.push(path);
    }}
    // Match the fixed compile-time inputs in production editors::read_catalogue.
    // This preflight never replaces its shell/ABI/peer/capability validation.
    const required=[...['Cargo.toml','Cargo.lock','src/lib.rs','src/ffi.rs','zle.c','zle.zsh','psreadline.cs','psreadline.ps1'].map(path=>`src-tauri/native-input-editors/${path}`),
      'src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_jobs.rs','src-tauri/src/terminal_jobs.ps1','src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs'];
    if(name==='editors-macos-arm64.json')required.push('scripts/native-input-p3/build.mjs','scripts/native-input-p3/zsh-build-check.c');
    if(catalogue.profiles.some(profile=>profile.core))required.push('scripts/dependency-builds/zsh/pin.json','scripts/dependency-builds/zsh/scoped-display-v1.patch','scripts/native-input-p3/build-scoped-core.mjs');
    if(name==='editors-linux-aarch64-glibc-2.36.json')required.push('src-tauri/native-input-adapter/Cargo.toml','src-tauri/native-input-adapter/Cargo.lock',
      'src-tauri/native-input-adapter/src/bin/native-input-relay.rs','scripts/native-input-p3/linux-build.sh','scripts/native-input-p3/publish-linux.py','scripts/native-input-p3/zsh-build-check.c');
    const missingInputs=required.filter(path=>!(path in catalogue.sources));
    entries.push({name,catalogueSha256:hash(resolve(resources,name)),profiles:catalogue.profiles.map(profile=>profile.profile.verifiedProfileId),sourceMismatches,artifactMismatches,missingInputs});
  }
  const selected=entries.find(entry=>entry.name===`editors-${selectedTarget}.json`);
  return{selectedTarget,entries,selectedValid:Boolean(selected&&selected.profiles.length&&![...selected.sourceMismatches,...selected.artifactMismatches,...selected.missingInputs].length)};
}
export function requireEditorResources(root,target){const audit=auditEditorResources(root,target);assert(audit.selectedValid,`Selected editor artifacts do not match the complete source snapshot: ${JSON.stringify(audit)}`);return audit;}

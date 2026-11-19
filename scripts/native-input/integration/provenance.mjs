import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';

export function recordAcceptanceInputs(root,directory,selection,version,scenario){
  const files=new Set();
  const collect=path=>{for(const entry of readdirSync(resolve(root,path),{withFileTypes:true})){
    if(['target','__pycache__'].includes(entry.name))continue;
    const name=`${path}/${entry.name}`;
    if(entry.isDirectory())collect(name);else if(/\.(rs|c|toml|lock|mjs|py|tsx?|patch)$/.test(entry.name))files.add(name);
  }};
  for(const path of['src-tauri/src/terminal_command','src-tauri/native-input-adapter','scripts/native-input/integration','scripts/dependency-builds/bash-native','src/lib/terminal'])collect(path);
  for(const path of['src-tauri/src/lib.rs','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','scripts/dependency-builds/xterm/artifacts.json','node_modules/@xterm/xterm/lib/xterm.js','node_modules/@xterm/xterm/lib/xterm.mjs'])files.add(path);
  for(const path of['scripts/native-input/prototype/build.py','scripts/native-input/prototype/readline-sources.json'])files.add(path);
  for(const path of['src-tauri/src/commands.rs','src-tauri/src/models.rs','src-tauri/src/session.rs','src-tauri/src/terminal_broker.rs','src-tauri/src/terminal_jobs.rs','src-tauri/src/agent_runtime/native/terminal_execute.rs','src-tauri/src/agent_runtime/native/terminal_lease.rs','src-tauri/src/agent_runtime/native/runtime.rs','src-tauri/src/agent_runtime/runtime.rs','src/components/terminal/registry/terminal-registry.ts','src/components/terminal/terminal-controller-layer.tsx','src/lib/ipc/tauri.ts','src/types/index.ts','scripts/verification/agent/verify-ai-session-stream.mjs','scripts/dev/dev-cargo-runner.mjs'])files.add(path);
  for(const entry of readdirSync(resolve(root,'src/components/terminal/__tests__')))if(/^(native-input-p2-|native-jobs|terminal-contention|terminal-delegation)/.test(entry)&&/\.tsx?$/.test(entry))files.add(`src/components/terminal/__tests__/${entry}`);
  const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const sources=Object.fromEntries([...files].sort().map(path=>[path,sha(resolve(root,path))]));
  const producers=[];
  for(const target of['macos-arm64','linux-aarch64-glibc-2.36']){
    const profile=`gnu-bash-${version}-readline-${{'4.1':'6.0','4.4':'7.0','5.3':'8.3.6'}[version]}-${target}-native`;
    const path=resolve(root,'artifacts/tests/native-input-p2/producers',profile,'manifest.json');
    if(target==='linux-aarch64-glibc-2.36'&&!existsSync(path))continue;
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    const cataloguePath=resolve(root,`artifacts/tests/native-input-p2/resources/native-input/catalogue-${target}.json`);
    const catalogue=JSON.parse(readFileSync(cataloguePath,'utf8'));
    producers.push({profile,manifest:relative(root,path),manifestSha256:sha(path),artifacts:manifest.artifacts,sources:manifest.sources,catalogueSha256:sha(cataloguePath),distributedArtifact:catalogue.profiles.find(value=>value.id===profile)});
  }
  writeFileSync(resolve(directory,'acceptance-inputs.json'),JSON.stringify({capturedAt:new Date().toISOString(),selection,version,scenario,modelRoutesSha256:sha(resolve(directory,'model-routes.json')),
    modelRouteSource:JSON.parse(readFileSync(resolve(directory,'route-source.json'),'utf8')),
    ...(existsSync(resolve(root,'artifacts/tests/native-input-p2/source-snapshot.json'))?{sourceSnapshot:{path:'artifacts/tests/native-input-p2/source-snapshot.json',sha256:sha(resolve(root,'artifacts/tests/native-input-p2/source-snapshot.json'))}}:{}),sources,producers},null,2),{mode:0o600});
}
